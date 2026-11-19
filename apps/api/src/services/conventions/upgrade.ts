import type pg from "pg";
import { resolve, toCompanyPart, validateConventions } from "./store.js";

export type LegacyTransform = (
  document: Record<string, unknown>,
  version: number,
) => Record<string, unknown>;

/** Turns a pre-format document into the current shape. Later issues each append one transform. */
export const LEGACY_TRANSFORMS: readonly LegacyTransform[] = [];

/**
 * Turns each stored complete document, one without `format`, into the
 * company's part: every value equal to its preset's is dropped, so the rules
 * in force stay as they were. Runs in the start's migration transaction, as
 * the migrator. A document with `format` is never read here, so a later
 * preset change is never taken for the company's.
 */
export async function upgradeStoredConventions(
  client: pg.Client,
): Promise<number> {
  const { rows } = await client.query<{
    version: number;
    document: Record<string, unknown>;
  }>(
    "select version, document from conventions where not document ? 'format' order by version",
  );
  for (const { version, document } of rows) {
    const current = LEGACY_TRANSFORMS.reduce(
      (each, transform) => transform(each, version),
      document,
    );
    const problems = validateConventions(current);
    if (problems.length > 0)
      throw new Error(
        `Version ${String(version)} of the conventions cannot be upgraded: ${JSON.stringify(problems)}`,
      );
    await client.query(
      "update conventions set document = $1 where version = $2",
      [JSON.stringify(toCompanyPart(resolve(current))), version],
    );
  }
  return rows.length;
}
