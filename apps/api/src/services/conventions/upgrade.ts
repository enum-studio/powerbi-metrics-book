import type pg from "pg";
import { createLogger, type Logger } from "../../log.js";
import { resolve, toSavablePart, validateConventions } from "./store.js";

export type LegacyTransform = (
  document: Record<string, unknown>,
  version: number,
) => Record<string, unknown>;

/** `checks.off` became the top-level `off`, which takes the same check names. */
const moveChecksOff: LegacyTransform = (document) => {
  const { checks, ...rest } = document;
  if (typeof checks !== "object" || checks === null || !("off" in checks))
    return document;
  const { off, ...others } = checks;
  return Object.keys(others).length === 0
    ? { ...rest, off }
    : { ...rest, checks: others, off };
};

class DraftingPatternError extends Error {
  constructor(
    readonly pattern: string,
    version: number,
  ) {
    super(
      `Conventions version ${String(version)} has the drafting pattern ${pattern}, which this release cannot turn into a prefix or a name. Rewrite it as a prefix or a name with \`pbmb conventions edit\` on the release before this one, then deploy again. Nothing was applied.`,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textSelector(
  pattern: string,
  version: number,
): { prefix: string } | { name: string } {
  const fail = (): never => {
    throw new DraftingPatternError(pattern, version);
  };
  if (!pattern.startsWith("^")) return fail();
  let text = "";
  for (let at = 1; at < pattern.length; at++) {
    const char = pattern.charAt(at);
    if (char === "$" && at === pattern.length - 1) return { name: text };
    if (char === "\\") {
      const escaped = pattern.charAt(++at);
      if (!escaped || !"^$\\.*+?()[]{}|/".includes(escaped)) return fail();
      text += escaped;
    } else {
      if ("^$.*+?()[]{}|".includes(char)) return fail();
      text += char;
    }
  }
  return { prefix: text };
}

const replaceDraftingPatterns: LegacyTransform = (document, version) => {
  if (!isRecord(document.drafting)) return document;
  const drafting = { ...document.drafting };
  if (isRecord(drafting.skip) && Array.isArray(drafting.skip.name_patterns)) {
    const { name_patterns, ...skip } = drafting.skip;
    const prefixes: string[] = [];
    const names: string[] = [];
    for (const pattern of name_patterns) {
      if (typeof pattern !== "string")
        throw new DraftingPatternError(String(pattern), version);
      const selector = textSelector(pattern, version);
      if ("prefix" in selector) prefixes.push(selector.prefix);
      else names.push(selector.name);
    }
    drafting.skip = { ...skip, name_prefixes: prefixes, names };
  }
  if (Array.isArray(drafting.dismiss)) {
    drafting.dismiss = drafting.dismiss.map((rule: unknown) => {
      if (!isRecord(rule) || typeof rule.name_pattern !== "string") return rule;
      const { name_pattern, ...rest } = rule;
      return { ...rest, ...textSelector(name_pattern, version) };
    });
  }
  return { ...document, drafting };
};

/** Turns a pre-format document into the current shape. Later issues each append one transform. */
export const LEGACY_TRANSFORMS: readonly LegacyTransform[] = [
  moveChecksOff,
  replaceDraftingPatterns,
];

/**
 * Turns each stored complete document, one without `format`, into the
 * company's part: every value equal to its preset's is dropped, so the rules
 * in force stay as they were. Runs in the start's migration transaction, as
 * the migrator. A document with `format` is never read here, so a later
 * preset change is never taken for the company's. The newest version must
 * upgrade, or the start stops; an older one that no longer resolves is left
 * as it was, with a warning, since nothing reads it in force. toSavablePart
 * drops, with a warning, a value set under a rule the part turns off.
 */
export async function upgradeStoredConventions(
  client: pg.Client,
  logger: Pick<Logger, "warn"> = createLogger("warn"),
): Promise<number> {
  const { rows } = await client.query<{
    version: number;
    document: Record<string, unknown>;
    newest: boolean;
  }>(
    "select version, document, version = (select max(version) from conventions) as newest from conventions where not document ? 'format' order by version",
  );
  let upgraded = 0;
  for (const { version, document, newest } of rows) {
    let current;
    try {
      current = LEGACY_TRANSFORMS.reduce(
        (each, transform) => transform(each, version),
        document,
      );
    } catch (error) {
      if (!(error instanceof DraftingPatternError) || newest) throw error;
      logger.warn(
        "an older version of the conventions no longer resolves and was left as it was",
        { version, pattern: error.pattern },
      );
      continue;
    }
    const problems = validateConventions(current);
    if (problems.length > 0 && newest)
      throw new Error(
        `Version ${String(version)} of the conventions cannot be upgraded: ${JSON.stringify(problems)}. The api will not start until it can. Go back to the previous release, save the conventions again with a valid value, then deploy this release.`,
      );
    if (problems.length > 0) {
      logger.warn(
        "an older version of the conventions no longer resolves and was left as it was",
        { version, paths: problems.map((problem) => problem.path).join(", ") },
      );
      continue;
    }
    const { part, dropped } = toSavablePart(resolve(current));
    if (dropped.length > 0)
      logger.warn(
        "a value set under a rule the conventions turn off had no effect and was dropped",
        { version, keys: dropped.join(", ") },
      );
    await client.query(
      "update conventions set document = $1 where version = $2",
      [JSON.stringify(part), version],
    );
    upgraded++;
  }
  return upgraded;
}
