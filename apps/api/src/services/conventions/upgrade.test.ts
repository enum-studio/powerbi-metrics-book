import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { rolledBack } from "../../../test/mirror-fixtures.js";
import { resolve, setConventions } from "./store.js";
import { upgradeStoredConventions } from "./upgrade.js";

// The upgrade runs as the migrator, inside the start's migration.
const migrator = new pg.Client({ connectionString: roleUrl("migrator") });
await migrator.connect();
afterAll(() => migrator.end());
afterAll(closeTestPools);
beforeEach(() => migrator.query("delete from conventions"));

const store = (version: number, document: object) =>
  migrator.query(
    "insert into conventions (version, document, set_by) values ($1, $2, 'test-admin')",
    [version, JSON.stringify(document)],
  );

type Row = { version: number; document: object; text: string; xmin: string };
const stored = async () =>
  (
    await migrator.query<Row>(
      "select version, document, document::text as text, xmin::text from conventions order by version",
    )
  ).rows;

describe("upgradeStoredConventions", () => {
  const withPattern = (pattern: string) => {
    const rules = resolve({});
    return {
      ...rules,
      drafting: {
        ...rules.drafting,
        skip: { ...rules.drafting.skip, name_patterns: [pattern] },
        dismiss: [{ name_pattern: pattern, reason: "Internal." }],
      },
    };
  };

  it.each(["^a.b", "foo", "(a|b)"])(
    "leaves an older version with pattern %s unchanged and warns with its version and pattern",
    async (pattern) => {
      const old = withPattern(pattern);
      await store(3, old);
      await store(4, resolve({}));
      const warnings: unknown[] = [];
      expect(
        await upgradeStoredConventions(migrator, {
          warn: (message, fields) => warnings.push({ message, fields }),
        }),
      ).toBe(1);
      expect((await stored())[0]?.document).toEqual(old);
      expect(warnings).toEqual([
        {
          message: expect.any(String) as unknown,
          fields: { version: 3, pattern },
        },
      ]);
    },
  );

  it("rolls back all changes when the newest version has an unconvertible pattern", async () => {
    await store(3, resolve({}));
    await store(4, withPattern("^a.b"));
    const before = await stored();
    await migrator.query("begin");
    try {
      await expect(upgradeStoredConventions(migrator)).rejects.toThrow(
        "Conventions version 4 has the drafting pattern ^a.b, which this release cannot turn into a prefix or a name. Rewrite it as a prefix or a name with `pbmb conventions edit` on the release before this one, then deploy again. Nothing was applied.",
      );
    } finally {
      await migrator.query("rollback");
    }
    expect(await stored()).toEqual(before);
  });

  it("turns each complete document into the company's part, resolving to the same rules", async () => {
    const preset = resolve({});
    const minimal = resolve({ preset: "minimal" });
    const kinds = [...preset.naming.kinds, "_share"];
    const complete = [
      preset,
      { ...preset, naming: { ...preset.naming, kinds } },
      {
        ...minimal,
        metric_fields: {
          ...minimal.metric_fields,
          when_to_use: { required: true },
        },
      },
    ];
    for (const [at, document] of complete.entries())
      await store(at + 1, document);

    expect(await upgradeStoredConventions(migrator)).toBe(3);

    const rows = await stored();
    expect(rows.map((row) => row.document)).toEqual([
      { format: 1, preset: "metrics_book" },
      { format: 1, preset: "metrics_book", naming: { kinds } },
      {
        format: 1,
        preset: "minimal",
        metric_fields: { when_to_use: { required: true } },
      },
    ]);
    expect(rows.map((row) => resolve(row.document))).toEqual(complete);
  });

  it("upgrades nothing twice, and never touches a document that has its format", async () => {
    await store(1, resolve({}));
    const part = {
      format: 1,
      preset: "metrics_book",
      naming: { case: "snake_case" },
    };
    await store(2, part);
    const [, before] = await stored();

    expect(await upgradeStoredConventions(migrator)).toBe(1);
    expect(await upgradeStoredConventions(migrator)).toBe(0);
    const [first, after] = await stored();
    expect(first?.document).toEqual({ format: 1, preset: "metrics_book" });
    expect(after).toEqual(before);
  });

  it("moves a pre-format document's checks.off to off", async () => {
    const rest = Object.fromEntries(
      Object.entries(resolve({})).filter(
        ([key]) => key !== "off" && key !== "exceptions",
      ),
    );
    await store(1, { ...rest, checks: { off: ["metric_base_variant"] } });
    expect(await upgradeStoredConventions(migrator)).toBe(1);
    const [row] = await stored();
    expect(row?.document).toEqual({
      format: 1,
      preset: "metrics_book",
      off: ["metric_base_variant"],
    });
  });

  it("drops a value set under a rule the document turns off, with a warning, so the part saves", async () => {
    const preset = resolve({});
    const unit = { ...preset.metric_fields.unit, values: ["money", "count"] };
    await store(1, {
      ...Object.fromEntries(
        Object.entries(preset).filter(
          ([key]) => key !== "off" && key !== "exceptions",
        ),
      ),
      checks: { off: ["metric_fields"] },
      metric_fields: { ...preset.metric_fields, unit },
      naming: { ...preset.naming, kinds: ["total_"] },
    });
    const warnings: { message: string; fields: unknown }[] = [];
    const logger = {
      warn: (message: string, fields: Record<string, unknown> = {}) =>
        warnings.push({ message, fields }),
    };
    expect(await upgradeStoredConventions(migrator, logger)).toBe(1);
    const [row] = await stored();
    const part = {
      format: 1,
      preset: "metrics_book",
      naming: { kinds: ["total_"] },
      off: ["metric_fields"],
    };
    expect(row?.document).toEqual(part);
    expect(warnings).toEqual([
      {
        message: expect.any(String) as unknown,
        fields: { version: 1, keys: "metric_fields.unit" },
      },
    ]);
    await rolledBack(async (tx) => {
      await setConventions({ db: tx }, principals.admin, part);
    });
  });

  it("leaves an older version it cannot resolve as it was, with one warning naming its version", async () => {
    const old = { preset: "strict", naming: { case: "none" } };
    await store(1, old);
    await store(2, resolve({}));
    const warnings: { message: string; version: unknown }[] = [];
    const logger = {
      warn: (message: string, fields: Record<string, unknown> = {}) =>
        warnings.push({ message, version: fields.version }),
    };
    expect(await upgradeStoredConventions(migrator, logger)).toBe(1);
    expect((await stored()).map((row) => row.document)).toEqual([
      old,
      { format: 1, preset: "metrics_book" },
    ]);
    expect(warnings).toEqual([
      { message: expect.any(String) as unknown, version: 1 },
    ]);
  });

  it("stops at a document it cannot read, naming its version, and changes nothing", async () => {
    await store(1, resolve({}));
    await store(2, { naming: { case: "camel_case" } });
    await migrator.query("begin");
    try {
      await expect(upgradeStoredConventions(migrator)).rejects.toThrow(
        /^Version 2 of the conventions cannot be upgraded: .*naming\.case.*\. The api will not start until it can\. Go back to the previous release, save the conventions again with a valid value, then deploy this release\.$/,
      );
    } finally {
      await migrator.query("rollback");
    }
    expect((await stored()).map((row) => row.document)).not.toContainEqual({
      format: 1,
      preset: "metrics_book",
    });
  });
});
