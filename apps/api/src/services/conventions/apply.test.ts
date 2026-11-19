import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import { metricIn, rolledBack } from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { bookChange, conventions } from "../../db/schema/book.js";
import { failuresInBook } from "../book/whole-book-checks.js";
import { applyConventions, changedRules } from "./apply.js";
import { currentConventions, listVersions, resolve } from "./store.js";

afterAll(closeTestPools);

const part = {
  format: 1,
  naming: { kinds: ["total_"] },
  off: ["metric_base_variant"],
} as const;
const BASELINE = "Names in use before the house style";

/** Three metrics with no word in common: two lack the kind total_. */
async function book(tx: Db): Promise<void> {
  for (const name of ["orders", "total_visits", "margin"])
    await metricIn(tx, name);
}

const apply = (tx: Db, input: { dry_run: boolean; baseline_reason?: string }) =>
  applyConventions({ db: tx }, principals.admin, {
    conventions: part,
    ...input,
  });

const stored = async (tx: Db) =>
  (await tx.select().from(conventions).orderBy(desc(conventions.version)))[0]
    ?.document;

describe("changedRules", () => {
  it("names a rule whose value, a key it reads, off state or exceptions change", () => {
    const before = resolve({});
    expect(changedRules(before, before)).toEqual([]);
    expect(
      changedRules(
        before,
        resolve({ naming: { qualifiers: { per: ["per"] } } }),
      ),
    ).toEqual(["metric_fields.not_the_same_as", "naming.qualifier_order"]);
    expect(
      changedRules(before, resolve({ off: ["metric_name_form"] })),
    ).toEqual(["naming.case", "naming.kinds"]);
    expect(
      changedRules(
        before,
        resolve({
          exceptions: [{ rule: "naming.case", metric: "Orders", reason: "." }],
        }),
      ),
    ).toEqual(["naming.case"]);
  });
});

describe("applyConventions", () => {
  it("says what changes and how many metrics then fail each rule, and a dry run saves nothing", () =>
    rolledBack(async (tx) => {
      await book(tx);
      expect(await apply(tx, { dry_run: true })).toEqual({
        changed_rules: [
          "metric_base_variant",
          "metric_fields.not_the_same_as",
          "naming.kinds",
        ],
        now_failing: {
          metric_base_variant: 0,
          "metric_fields.not_the_same_as": 0,
          "naming.kinds": 2,
        },
        exceptions_added: 0,
        version: null,
      });
      expect(
        await apply(tx, { dry_run: true, baseline_reason: BASELINE }),
      ).toMatchObject({ exceptions_added: 2, version: null });
      expect(await listVersions(tx)).toEqual([]);
    }));

  it("saves the part as given, even with names failing, and records the change", () =>
    rolledBack(async (tx) => {
      await book(tx);
      expect(await apply(tx, { dry_run: false })).toMatchObject({
        now_failing: { "naming.kinds": 2 },
        version: 1,
      });
      expect(await stored(tx)).toEqual(part);
      const changes = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_kind, "conventions"));
      expect(changes).toMatchObject([{ element_id: "1", action: "update" }]);
    }));

  it("writes one exception for each failure of a changed rule with a baseline reason", () =>
    rolledBack(async (tx) => {
      await book(tx);
      expect(
        await apply(tx, { dry_run: false, baseline_reason: BASELINE }),
      ).toMatchObject({
        now_failing: { "naming.kinds": 2 },
        exceptions_added: 2,
        version: 1,
      });
      expect(await stored(tx)).toEqual({
        ...part,
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: BASELINE },
          { rule: "naming.kinds", metric: "margin", reason: BASELINE },
        ],
      });
      const inForce = await currentConventions(tx);
      expect(
        await failuresInBook({ db: tx }, inForce, new Set(["naming.kinds"])),
      ).toEqual([]);
      // The part as given drops those exceptions again, which changes the rule.
      expect(await apply(tx, { dry_run: true })).toMatchObject({
        changed_rules: ["naming.kinds"],
        now_failing: { "naming.kinds": 2 },
      });
    }));

  it("takes only a company part", () =>
    rolledBack(async (tx) => {
      await expect(
        applyConventions({ db: tx }, principals.admin, {
          conventions: { naming: { kinds: ["total_"] } },
          dry_run: true,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));
});
