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

/** Turns a pre-format document into the current shape. Later issues each append one transform. */
export const LEGACY_TRANSFORMS: readonly LegacyTransform[] = [moveChecksOff];

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
    const current = LEGACY_TRANSFORMS.reduce(
      (each, transform) => transform(each, version),
      document,
    );
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
