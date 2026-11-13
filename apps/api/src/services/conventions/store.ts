import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { desc, sql } from "drizzle-orm";
import { parse } from "yaml";
import type { z } from "zod";
import type { AppDeps, Db } from "../../context.js";
import { conventions } from "../../db/schema/book.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { recordBookChange } from "../book/changes.js";
import { withEvents } from "../events/feed.js";
import {
  type Conventions,
  conventionsSchema,
  PRESET_NAMES,
  type PresetName,
} from "./schema.js";

export type ConventionsProblem = { path: string; message: string };
export type ConventionsChange = {
  path: string;
  before: unknown;
  after: unknown;
};
export type ConventionsVersion = typeof conventions.$inferSelect;

/**
 * The repository's conventions/presets, five folders above this module:
 * from apps/api/src/services/conventions in a checkout, and from
 * apps/api/dist/services/conventions in the image, which mirrors the
 * repository's layout under /app.
 */
export function presetsFolder(moduleUrl: URL): URL {
  return new URL("../../../../../conventions/presets/", moduleUrl);
}

const PRESETS_FOLDER = presetsFolder(new URL(import.meta.url));
const presets = new Map<PresetName, Record<string, unknown>>();
/** The advisory lock every save of the conventions takes. */
export const CONVENTIONS_LOCK = "powerbi_metrics_book.conventions";

type Document = Record<string, unknown>;

const isDocument = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPresetName = (value: unknown): value is PresetName =>
  PRESET_NAMES.some((name) => name === value);

function preset(name: PresetName): Document {
  const cached = presets.get(name);
  if (cached !== undefined) return cached;
  const file = new URL(`${name}.yml`, PRESETS_FOLDER);
  const document: unknown = parse(readFileSync(file, "utf8"));
  if (!isDocument(document)) {
    throw new Error(
      `The ${name} preset (${file.pathname}) is not a mapping of keys.`,
    );
  }
  presets.set(name, document);
  return document;
}

/**
 * Objects are merged key by key; anything else, arrays included, is replaced
 * whole. fromEntries makes every key the document's own, so a "__proto__"
 * key stays a key the schema refuses instead of a prototype.
 */
function merge(base: Document, over: Document): Document {
  const keys = new Set([...Object.keys(base), ...Object.keys(over)]);
  return Object.fromEntries(
    [...keys].map((key) => {
      const under = base[key];
      if (!Object.hasOwn(over, key)) return [key, under];
      const value = over[key];
      const both = isDocument(under) && isDocument(value);
      return [key, both ? merge(under, value) : value];
    }),
  );
}

function problemsOf(error: z.ZodError): ConventionsProblem[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((unknownKey) => ({
        path: [...path, unknownKey].join("."),
        message:
          "The conventions have no such key. Check its spelling and where it sits.",
      }));
    }
    return [{ path: path.join("."), message: issue.message }];
  });
}

const refused = (path: string, message: string) => ({
  problems: [{ path, message }],
});

function tryResolve(
  document: unknown,
): { conventions: Conventions } | { problems: ConventionsProblem[] } {
  if (!isDocument(document)) {
    return refused("", "The conventions are a mapping of keys.");
  }
  const named = document.preset ?? "metrics_book";
  if (!isPresetName(named)) {
    return refused("preset", `Name a preset: ${PRESET_NAMES.join(" or ")}.`);
  }
  const parsed = conventionsSchema.safeParse(merge(preset(named), document));
  return parsed.success
    ? { conventions: parsed.data }
    : { problems: problemsOf(parsed.error) };
}

/** What is wrong with a document, path by path; empty when it is valid. */
export function validateConventions(document: unknown): ConventionsProblem[] {
  const resolved = tryResolve(document);
  return "problems" in resolved ? resolved.problems : [];
}

/**
 * The preset the document names (metrics_book when it names none) merged
 * under the document's own keys, then checked whole.
 */
export function resolve(document: unknown): Conventions {
  const resolved = tryResolve(document);
  if ("conventions" in resolved) return resolved.conventions;
  const listed = resolved.problems
    .map((problem) => `${problem.path || "the document"}: ${problem.message}`)
    .join("; ");
  throw new ServiceError(
    "invalid",
    `The conventions are not valid. ${listed}`,
    {
      problems: resolved.problems,
    },
  );
}

async function newest(db: Db): Promise<ConventionsVersion | undefined> {
  const [row] = await db
    .select()
    .from(conventions)
    .orderBy(desc(conventions.version))
    .limit(1);
  return row;
}

/**
 * A stored version is complete, so resolving it only fills keys a later
 * release added. One that no longer resolves is a fault to fix, not a reason
 * to fall back to other rules.
 */
function inForce(version: ConventionsVersion | undefined): Conventions {
  if (version === undefined) return resolve({ preset: "metrics_book" });
  const resolved = tryResolve(version.document);
  if ("conventions" in resolved) return resolved.conventions;
  throw new Error(
    `Version ${String(version.version)} of the conventions is no longer valid: ${JSON.stringify(resolved.problems)}`,
  );
}

/** The newest version; the metrics_book preset while none is stored. */
export async function currentConventions(db: Db): Promise<Conventions> {
  return inForce(await newest(db));
}

export function listVersions(db: Db): Promise<ConventionsVersion[]> {
  return db.select().from(conventions).orderBy(desc(conventions.version));
}

/** Arrays are compared whole, as resolve replaces them whole. */
export function diffConventions(
  current: Conventions,
  proposed: Conventions,
): ConventionsChange[] {
  const changes: ConventionsChange[] = [];
  const walk = (before: unknown, after: unknown, path: string[]): void => {
    if (isDocument(before) && isDocument(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        walk(before[key], after[key], [...path, key]);
      }
    } else if (!isDeepStrictEqual(before, after)) {
      changes.push({
        path: path.join("."),
        before: before ?? null,
        after: after ?? null,
      });
    }
  };
  walk(current, proposed, []);
  return changes;
}

/**
 * trust.* decides who may verify and approve, so a token that could rewrite it
 * could let an agent approve its own work: a change to any trust key comes
 * from a person in a browser session, and every other key changes from the CLI
 * too. approval_browser_only_security_test holds it.
 */
function refuseTrustChangeUnlessBrowser(
  principal: Principal,
  changes: ConventionsChange[],
): void {
  if (
    changes.some(({ path }) => path === "trust" || path.startsWith("trust.")) &&
    !(principal.kind === "person" && principal.via === "browser")
  ) {
    throw new ServiceError(
      "refused",
      "The trust rules (trust.*) decide who may verify and approve, so they change only in the admin section of the web app, signed in as a person. Change the other rules here, and ask a person to change these there.",
    );
  }
}

/**
 * Saves the next version. The trust rule is checked here, against the version
 * read under the lock this save writes under, so every caller gets it and no
 * save can land between the check and the write.
 */
export async function setConventions(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  document: unknown,
): Promise<{
  version: number;
  conventions: Conventions;
  changes: ConventionsChange[];
}> {
  const proposed = resolve(document);
  return withEvents(deps.db, async (tx, emit) => {
    // Versions are numbered in order, so two admins saving at once take turns.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${CONVENTIONS_LOCK}, 0))`,
    );
    const previous = await newest(tx);
    const before = inForce(previous);
    const version = (previous?.version ?? 0) + 1;
    const changes = diffConventions(before, proposed);
    refuseTrustChangeUnlessBrowser(principal, changes);
    await tx
      .insert(conventions)
      .values({ version, document: proposed, set_by: principal.id });
    await recordBookChange(tx, {
      principal,
      element_kind: "conventions",
      element_id: String(version),
      action: "update",
      before,
      after: proposed,
    });
    emit({
      kind: "conventions.changed",
      element_kind: "conventions",
      element_id: String(version),
      principal,
      data: { version, paths: changes.map((change) => change.path) },
    });
    return { version, conventions: proposed, changes };
  });
}
