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
import { type NewEvent, withEvents } from "../events/feed.js";
import { FIXED_RULES, isDocument, isRuleOff, RULES, valueAt } from "./rules.js";
import {
  companyPartSchema,
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

/** The format a company part carries, as the conventions file does. */
export const CONVENTIONS_FORMAT = 1;
/**
 * What a company set over its preset: the version stored, and the file.
 * Resolving it over the preset gives the conventions in force. A document
 * without `format` is a complete one, written before a company part was stored.
 */
export type CompanyPart = {
  readonly format: typeof CONVENTIONS_FORMAT;
  readonly preset?: PresetName;
  readonly [key: string]: unknown;
};

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

/** What a client may branch on when a document is refused: the code, and the rule it is about. */
type Refusal = {
  problems: ConventionsProblem[];
  code?: "conventions.fixed" | "conventions.off_and_set";
  rule?: string;
};

const refused = (path: string, message: string): Refusal => ({
  problems: [{ path, message }],
});

export const isCompanyPart = (document: unknown): document is CompanyPart =>
  isDocument(document) && document.format === CONVENTIONS_FORMAT;

/**
 * The fixed rule a document tries to change: a format other than this
 * release's, a key it holds, or one named in `off` or as an exception's rule.
 */
function fixedRuleIn(format: unknown, rules: Document): Refusal | undefined {
  const { off, exceptions } = rules;
  const otherFormat = format !== undefined && format !== CONVENTIONS_FORMAT;
  const named = (id: string): string | undefined => {
    if (id === "format" && otherFormat) return "format";
    // `format` is not among `rules`, so for it the rest finds off and exceptions.
    if (valueAt(rules, id.split(".")) !== undefined) return id;
    if (Array.isArray(off) && off.includes(id)) return "off";
    const excepted =
      Array.isArray(exceptions) &&
      exceptions.some((item) => isDocument(item) && item.rule === id);
    return excepted ? "exceptions" : undefined;
  };
  for (const { id, reason } of FIXED_RULES) {
    const path = named(id);
    if (path === undefined) continue;
    const fixed =
      path === "format"
        ? `This release reads format ${String(CONVENTIONS_FORMAT)} of the conventions.`
        : `${id} stays fixed.`;
    return {
      problems: [{ path, message: `${fixed} ${reason}` }],
      code: "conventions.fixed",
      rule: id,
    };
  }
  return undefined;
}

function tryResolve(document: unknown): { conventions: Conventions } | Refusal {
  if (!isDocument(document)) {
    return refused("", "The conventions are a mapping of keys.");
  }
  const { format, ...rules } = document;
  const fixed = fixedRuleIn(format, rules);
  if (fixed !== undefined) return fixed;
  const named = rules.preset ?? "metrics_book";
  if (!isPresetName(named)) {
    return refused("preset", `Name a preset: ${PRESET_NAMES.join(" or ")}.`);
  }
  const parsed = conventionsSchema.safeParse(merge(preset(named), rules));
  return parsed.success
    ? { conventions: parsed.data }
    : { problems: problemsOf(parsed.error) };
}

/** What is wrong with a document, path by path; empty when it is valid. */
export function validateConventions(document: unknown): ConventionsProblem[] {
  const resolved = tryResolve(document);
  return "problems" in resolved ? resolved.problems : [];
}

function refusal({ problems, code, rule }: Refusal): ServiceError {
  const listed = problems
    .map((problem) => `${problem.path || "the document"}: ${problem.message}`)
    .join("; ");
  return new ServiceError(
    "invalid",
    `The conventions are not valid. ${listed}`,
    code === undefined ? { problems } : { problems, code, rule },
  );
}

/**
 * The preset the document names (metrics_book when it names none) merged
 * under the document's own keys, then checked whole. The document is a
 * company part or a complete document; `format` is not a rule, so it goes.
 */
export function resolve(document: unknown): Conventions {
  const resolved = tryResolve(document);
  if ("conventions" in resolved) return resolved.conventions;
  throw refusal(resolved);
}

/**
 * The ids, each its key's dotted path, of the rules a part sets and turns off
 * in its own `off`, which resolve takes whole; one only the preset turns off
 * may take a value.
 */
function setAndTurnedOff(part: CompanyPart, resolved: Conventions): string[] {
  if (valueAt(part, ["off"]) === undefined) return [];
  return RULES.filter(
    (rule) =>
      rule.path !== null &&
      valueAt(part, rule.path) !== undefined &&
      isRuleOff(rule, resolved),
  ).map((rule) => rule.id);
}

/**
 * A part that sets a rule's value and turns that rule off says two things
 * about it, so it is refused: a file says one thing about each rule.
 */
function refuseOffAndSet(part: CompanyPart, resolved: Conventions): void {
  const [both] = setAndTurnedOff(part, resolved);
  if (both === undefined) return;
  throw refusal({
    problems: [
      {
        path: both,
        message: `It sets ${both} and turns it off. Take it out of off, or leave its value to the preset.`,
      },
    ],
    code: "conventions.off_and_set",
    rule: both,
  });
}

/** `document` without the value at `path`; a mapping left empty goes too. */
function without(document: Document, path: readonly string[]): Document {
  const [key, ...rest] = path;
  if (key === undefined) return document;
  const { [key]: under, ...others } = document;
  const kept = isDocument(under) && rest.length > 0 ? without(under, rest) : {};
  return Object.keys(kept).length === 0 ? others : { ...others, [key]: kept };
}

/**
 * The leaves of `document` that differ from the same path in `base`: objects
 * key by key, arrays and every other value whole. An object left empty goes.
 */
function differing(document: Document, base: Document): Document {
  return Object.fromEntries(
    Object.entries(document).flatMap(([key, value]) => {
      const under = Object.hasOwn(base, key) ? base[key] : undefined;
      if (isDocument(value) && isDocument(under)) {
        const kept = differing(value, under);
        return Object.keys(kept).length === 0 ? [] : [[key, kept]];
      }
      return isDeepStrictEqual(value, under) ? [] : [[key, value]];
    }),
  );
}

/**
 * The company's part of resolved conventions: its preset and every value that
 * differs from that preset's, so resolving it gives the same conventions back.
 */
export function toCompanyPart(document: Conventions): CompanyPart {
  const { preset: named, ...rules } = document;
  return {
    format: CONVENTIONS_FORMAT,
    preset: named,
    ...differing(rules, resolve({ preset: named })),
  };
}

/**
 * The company's part as toCompanyPart makes it, less each value set under a
 * rule its own `off` turns off: the value had no effect, and a save refuses
 * it. `dropped` names those rules.
 */
export function toSavablePart(resolved: Conventions) {
  const company = toCompanyPart(resolved);
  const dropped = setAndTurnedOff(company, resolved);
  let part: Document = company;
  for (const id of dropped) part = without(part, id.split("."));
  return { part, dropped };
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
 * A stored version is resolved over its preset as the release ships it, so a
 * key the company did not set takes the preset's value. One that no longer
 * resolves is a fault to fix, not a reason to fall back to other rules.
 */
function inForce(version: ConventionsVersion | undefined): Conventions {
  if (version === undefined) return resolve({ preset: "metrics_book" });
  const resolved = tryResolve(version.document);
  if ("conventions" in resolved) return resolved.conventions;
  throw new Error(
    `Version ${String(version.version)} of the conventions is no longer valid: ${JSON.stringify(resolved.problems)}`,
  );
}

/** The version in force: its number, resolved, and the company's part of it as stored. */
export type InForce = {
  version: number;
  conventions: Conventions;
  company: CompanyPart;
};

/** The version in force, read without the lock: for an answer that saves nothing. */
export async function conventionsInForce(db: Db): Promise<InForce> {
  const version = await newest(db);
  const resolved = inForce(version);
  const stored = version?.document;
  return {
    version: version?.version ?? 0,
    conventions: resolved,
    company: isCompanyPart(stored) ? stored : toCompanyPart(resolved),
  };
}

/** The newest version; the metrics_book preset while none is stored. */
export async function currentConventions(db: Db): Promise<Conventions> {
  return inForce(await newest(db));
}

/**
 * Every version, newest first, each resolved as it is read in force. An older
 * one that no longer resolves, which nothing reads in force, is listed as
 * stored.
 */
export async function listVersions(db: Db): Promise<ConventionsVersion[]> {
  const versions = await db
    .select()
    .from(conventions)
    .orderBy(desc(conventions.version));
  return versions.map((version, at) => {
    const resolved = tryResolve(version.document);
    if ("conventions" in resolved)
      return { ...version, document: resolved.conventions };
    return at === 0 ? { ...version, document: inForce(version) } : version;
  });
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
 * too. Pinning or unpinning a trust key in the company's part is a change as
 * well, since it decides whether a later preset change reaches the key.
 * approval_browser_only_security_test and conventions_security_test hold it.
 */
function refuseTrustChangeUnlessBrowser(
  principal: Principal,
  changes: ConventionsChange[],
  before: CompanyPart,
  after: CompanyPart,
): void {
  if (
    (changes.some(
      ({ path }) => path === "trust" || path.startsWith("trust."),
    ) ||
      !isDeepStrictEqual(before.trust, after.trust)) &&
    !(principal.kind === "person" && principal.via === "browser")
  ) {
    throw new ServiceError(
      "refused",
      "The trust rules (trust.*) decide who may verify and approve, so they change only in the admin section of the web app, signed in as a person. Change the other rules here, and ask a person to change these there.",
    );
  }
}

/**
 * The company's part a document makes: a part as the schema reads it, so
 * what the schema drops, such as a "__proto__" key in a record, is not
 * stored; a complete document as what differs from its preset. A complete
 * document holds every trust key, so one whose trust rules are those in force
 * keeps the stored part's trust as it is, pinned or not.
 */
function partOf(
  document: unknown,
  proposed: Conventions,
  current: InForce,
): CompanyPart {
  // resolve has checked the part merged over its preset, so this parse holds.
  if (isCompanyPart(document)) return companyPartSchema.parse(document);
  const { trust, ...part } = toCompanyPart(proposed);
  const kept = isDeepStrictEqual(proposed.trust, current.conventions.trust)
    ? current.company.trust
    : trust;
  return kept === undefined ? part : { ...part, trust: kept };
}

/** Takes the save lock for the rest of the transaction, so versions are numbered in order and two admins take turns. */
export async function lockConventions(tx: Db): Promise<InForce> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${CONVENTIONS_LOCK}, 0))`,
  );
  return conventionsInForce(tx);
}

/** A document checkSave passed, with whom it was checked for and the version it would follow. */
export type CheckedSave = {
  principal: Principal;
  current: InForce;
  part: CompanyPart;
  proposed: Conventions;
  changes: ConventionsChange[];
};

/**
 * Checks `document` against `current` as a save would: valid, saying one
 * thing about each rule, and changing trust.* only from a browser.
 */
export function checkSave(
  principal: Principal,
  current: InForce,
  document: unknown,
): CheckedSave {
  const proposed = resolve(document);
  const part = partOf(document, proposed, current);
  refuseOffAndSet(part, proposed);
  const changes = diffConventions(current.conventions, proposed);
  refuseTrustChangeUnlessBrowser(principal, changes, current.company, part);
  return { principal, current, part, proposed, changes };
}

/**
 * Saves a checked document as the next version after the one it was checked
 * against, which the caller read under lockConventions in this transaction:
 * the row, its record in book_change and its event.
 */
export async function saveVersion(
  tx: Db,
  emit: (event: NewEvent) => void,
  { principal, current, part, proposed, changes }: CheckedSave,
): Promise<{
  version: number;
  conventions: Conventions;
  changes: ConventionsChange[];
}> {
  const version = current.version + 1;
  await tx
    .insert(conventions)
    .values({ version, document: part, set_by: principal.id });
  await recordBookChange(tx, {
    principal,
    element_kind: "conventions",
    element_id: String(version),
    action: "update",
    before: current.conventions,
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
}

/**
 * Saves the next version. The trust rule is checked here, against the version
 * read under the lock this save writes under, so every caller gets it and no
 * save can land between the check and the write. A company part is stored as
 * validated, values equal to the preset's included; a complete document as
 * what differs from its preset.
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
  // Checked before the lock, so a document that cannot be valid waits for nothing.
  resolve(document);
  return withEvents(deps.db, async (tx, emit) => {
    const current = await lockConventions(tx);
    return saveVersion(tx, emit, checkSave(principal, current, document));
  });
}
