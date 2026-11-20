import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import {
  asPerson,
  metricIn,
  rolledBack,
} from "../../../test/mirror-fixtures.js";
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

/** Three metrics with no word in common, each with a kind of the preset: two lack the kind total_. */
async function book(tx: Db): Promise<void> {
  for (const name of ["number_of_orders", "total_visits", "average_margin"])
    await metricIn(tx, name);
}

const apply = (
  tx: Db,
  input: { dry_run: boolean; baseline_reason?: string },
  conventions: object = part,
) =>
  applyConventions(asPerson(principals.admin, { db: tx }), {
    conventions,
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
        exceptions_added: [],
        version: null,
      });
      expect(
        await apply(tx, { dry_run: true, baseline_reason: BASELINE }),
      ).toMatchObject({
        exceptions_added: [
          { rule: "naming.kinds", metric: "average_margin", reason: BASELINE },
          {
            rule: "naming.kinds",
            metric: "number_of_orders",
            reason: BASELINE,
          },
        ],
        version: null,
      });
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

  it("writes one exception for each failure of a changed rule with a baseline reason, and lists them sorted", () =>
    rolledBack(async (tx) => {
      await book(tx);
      const exceptions = [
        { rule: "naming.kinds", metric: "average_margin", reason: BASELINE },
        { rule: "naming.kinds", metric: "number_of_orders", reason: BASELINE },
      ];
      expect(
        await apply(tx, { dry_run: false, baseline_reason: BASELINE }),
      ).toMatchObject({
        now_failing: { "naming.kinds": 2 },
        exceptions_added: exceptions,
        version: 1,
      });
      expect(await stored(tx)).toEqual({ ...part, exceptions });
      const inForce = await currentConventions(tx);
      expect(
        await failuresInBook({ db: tx }, inForce, new Set(["naming.kinds"])),
      ).toEqual([]);
      // The part as given drops those exceptions again, which changes the rule.
      expect(await apply(tx, { dry_run: true })).toMatchObject({
        changed_rules: ["naming.kinds"],
        now_failing: { "naming.kinds": 2 },
      });
      // The file the CLI writes holds them, in any order, so applying it again adds none and saves nothing.
      for (const listed of [exceptions, [...exceptions].reverse()])
        for (const baseline_reason of [undefined, BASELINE])
          expect(
            await apply(
              tx,
              { dry_run: false, ...(baseline_reason && { baseline_reason }) },
              { ...part, exceptions: listed },
            ),
          ).toEqual({
            changed_rules: [],
            now_failing: {},
            exceptions_added: [],
            version: 1,
          });
      expect(await listVersions(tx)).toHaveLength(1);
      // A file without them is saved as given, and they are gone, with the baseline too: it changes only the rule's exceptions.
      expect(
        await apply(tx, { dry_run: false, baseline_reason: BASELINE }),
      ).toMatchObject({
        changed_rules: ["naming.kinds"],
        now_failing: { "naming.kinds": 2 },
        exceptions_added: [],
        version: 2,
      });
      expect(await stored(tx)).toEqual(part);
    }));

  it("adds no baseline exception for a part that changes only a rule's exceptions", () =>
    rolledBack(async (tx) => {
      await book(tx);
      const exceptions = [
        {
          rule: "metric_fields.definition",
          metric: "total_visits",
          reason: "Kept.",
        },
      ];
      expect(
        await apply(
          tx,
          { dry_run: false, baseline_reason: BASELINE },
          { format: 1, exceptions },
        ),
      ).toMatchObject({
        changed_rules: ["metric_fields.definition"],
        now_failing: { "metric_fields.definition": 2 },
        exceptions_added: [],
      });
      expect(await stored(tx)).toEqual({ format: 1, exceptions });
    }));

  it("excepts exactly the targets that fail a rule the part turns on", () =>
    rolledBack(async (tx) => {
      await book(tx);
      await apply(
        tx,
        { dry_run: false },
        { format: 1, off: ["metric_fields.definition"] },
      );
      expect(
        await apply(
          tx,
          { dry_run: true, baseline_reason: BASELINE },
          { format: 1 },
        ),
      ).toEqual({
        changed_rules: ["metric_fields.definition"],
        now_failing: { "metric_fields.definition": 3 },
        exceptions_added: [
          "average_margin",
          "number_of_orders",
          "total_visits",
        ].map((metric) => ({
          rule: "metric_fields.definition",
          metric,
          reason: BASELINE,
        })),
        version: null,
      });
    }));

  it("leaves a metric that failed the rule before the change to keep failing", () =>
    rolledBack(async (tx) => {
      await book(tx);
      await metricIn(tx, "orders");
      // orders has no kind of the preset; total_visits has one this part leaves out.
      expect(
        await apply(
          tx,
          { dry_run: true, baseline_reason: BASELINE },
          { format: 1, naming: { kinds: ["number_of_", "average_"] } },
        ),
      ).toMatchObject({
        now_failing: { "naming.kinds": 2 },
        exceptions_added: [
          { rule: "naming.kinds", metric: "total_visits", reason: BASELINE },
        ],
      });
    }));

  it("saves nothing, and records nothing, for a part equal to the one in force", () =>
    rolledBack(async (tx) => {
      await book(tx);
      await apply(tx, { dry_run: false });
      for (const dry_run of [true, false])
        expect(await apply(tx, { dry_run })).toEqual({
          changed_rules: [],
          now_failing: {},
          exceptions_added: [],
          version: dry_run ? null : 1,
        });
      expect(await listVersions(tx)).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(bookChange)
          .where(eq(bookChange.element_kind, "conventions")),
      ).toHaveLength(1);
    }));

  it("takes only a company part", () =>
    rolledBack(async (tx) => {
      await expect(
        applyConventions(asPerson(principals.admin, { db: tx }), {
          conventions: { naming: { kinds: ["total_"] } },
          dry_run: true,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));
});
