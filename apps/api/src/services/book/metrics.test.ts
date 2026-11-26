import { randomUUID } from "node:crypto";
import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { bookChange, metric, metricVariant } from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import type { Principal } from "../../principal.js";
import { setConventionsAsAdmin } from "../conventions/service.js";
import { createCategory } from "./categories.js";
import { draftDatasets } from "./drafter.js";
import {
  approveMetric,
  createMetric,
  deleteMetric,
  dismissMetric,
  getMetric,
  listMetrics,
  mergeMetrics,
  metricChecks,
  metricHistory,
  renameMetric,
  summarizeBook,
  updateMetric,
  verifyMetric,
} from "./metrics.js";

afterAll(closeTestPools);

/*
 * Each test drafts the sample mirror under the default conventions and acts
 * as the api in a transaction that is rolled back. The principals' Power BI
 * lists are written by hand from the sample tenant's access table.
 */

const SALES = "Sales";
const FINANCE = "Finance";
const MARKETING = "Marketing";
const tenant = sampleTenant();
const idOf = (items: { id: string; name: string }[], name: string) => {
  const found = items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`The sample has no ${name}`);
  return found.id;
};
/** The workspace that holds the sample's dataset of this name. */
const workspaceId = (dataset: string) => {
  const found = tenant.datasets.find((item) => item.name === dataset);
  if (found === undefined) throw new Error(`The sample has no ${dataset}`);
  return found.workspace_id;
};
const datasetId = (name: string) => idOf(tenant.datasets, name);

/** The sample's Admin, as a curator: every workspace. */
const curator = reaching(
  { powerbi_workspace_ids: [SALES, FINANCE, MARKETING].map(workspaceId) },
  "curator",
);
/** The Analyst, as a curator: the Commercial workspace only. */
const salesCurator = reaching(
  { powerbi_workspace_ids: [workspaceId(SALES)] },
  "curator",
);
/** The Viewer: the Sales app. */
const viewer = reaching({
  powerbi_app_ids: [idOf(tenant.apps, "Sales app")],
});
/** The Leader: the Leadership app, which shows Finance. */
const leader = reaching({
  powerbi_app_ids: [idOf(tenant.apps, "Leadership app")],
});
const token = (principal: Principal): Principal => ({
  ...principal,
  via: "cli",
});

const drafted = (work: (tx: Db, sample: SampleMirror) => Promise<void>) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draftDatasets(
      createTestDeps({ container: "worker", db: tx }),
      sample.tenant.datasets.map((dataset) => dataset.id),
    );
    await setRole(tx, "api_rw");
    await work(tx, sample);
  });

/** The key of the draft the drafter filed the measure under. */
async function draftOf(
  tx: Db,
  sample: SampleMirror,
  dataset: string,
  measure: string,
): Promise<string> {
  const [row] = await tx
    .select({ name: metric.name })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(
      eq(metricVariant.measure_id, sample.measureId({ dataset, measure })),
    );
  if (row === undefined) throw new Error(`${measure} is not filed`);
  return row.name;
}

const BASE_SHIFT = {
  comparison: "none",
  comparison_period: null,
  currency: null,
  custom_axes: {},
};

describe("getMetric", () => {
  it("orders the rename of a generated key only for a curator off the connector", () =>
    drafted(async (tx, sample) => {
      const name = await draftOf(tx, sample, SALES, "Net sales");
      const said = async (principal: Principal) =>
        (await getMetric(asPerson(principal, { db: tx }), name)).failing_checks
          .find(({ check }) => check === "metric_name_generated")
          ?.message.includes("Rename");
      expect(await said(token(curator))).toBe(true);
      expect(await said(token(viewer))).toBe(false);
      expect(await said({ ...curator, via: "mcp" })).toBe(false);
    }));

  it("says other on a draft whose only measure is time-shifted, and does not fail it for having no base", () =>
    drafted(async (tx, sample) => {
      const name = await draftOf(tx, sample, SALES, "Web net sales LY");
      const page = await getMetric(asPerson(curator, { db: tx }), name);
      expect(page.base_variants).toMatchObject([
        { measure: { name: "Web net sales LY" }, period: "other" },
      ]);
      expect(page.other_variants).toEqual([]);
      expect(page.failing_checks.map(({ check }) => check)).not.toContain(
        "metric_base_variant",
      );
    }));

  it("gives the base variant in each dataset the caller may describe and counts the rest by shift", () =>
    drafted(async (tx, sample) => {
      const name = await draftOf(tx, sample, SALES, "Net sales");
      const full = await getMetric(asPerson(curator, { db: tx }), name);
      expect(
        full.base_variants.map((base) => [
          base.dataset.name,
          base.measure_reference,
        ]),
      ).toEqual([
        [SALES, "[Net sales]"],
        [MARKETING, "[Net Sales]"],
      ]);
      expect(full.other_variants).toContainEqual({
        shift: { ...BASE_SHIFT, period: "previous_year" },
        count: 1,
      });
      expect(full.other_variants).toContainEqual({
        shift: {
          ...BASE_SHIFT,
          period: "current",
          comparison: "growth_rate",
          comparison_period: "previous_year",
        },
        count: 1,
      });
      expect(full).toMatchObject({
        kind: "metric",
        origin: "sync",
        trust_state: "draft",
        category: null,
        terms: [],
      });
      expect(full.failing_checks.map((failing) => failing.check)).toContain(
        "metric_name_generated",
      );

      // Through the Sales app only Sales shows. The Leadership app shows Finance,
      // which calls this calculation Revenue, so a leader never reads this name.
      const seen = async (principal: Principal) =>
        (await getMetric(asPerson(principal, { db: tx }), full.id))
          .base_variants;
      expect((await seen(viewer)).map((base) => base.measure.name)).toEqual([
        "Net sales",
      ]);
      await expect(seen(leader)).rejects.toMatchObject({ kind: "not_found" });
      const forViewer = await getMetric(asPerson(viewer, { db: tx }), name);
      expect(forViewer.other_variants).toContainEqual({
        shift: { ...BASE_SHIFT, period: "previous_year" },
        count: 1,
      });
    }));

  it("answers not_found to a caller who may describe no dataset of the metric", () =>
    drafted(async (tx, sample) => {
      const sessions = await draftOf(tx, sample, MARKETING, "Sessions");
      await expect(
        getMetric(asPerson(viewer, { db: tx }), sessions),
      ).rejects.toMatchObject({ kind: "not_found" });
      await expect(
        getMetric(asPerson(reaching({}), { db: tx }), sessions),
      ).rejects.toMatchObject({ kind: "not_found" });
      // A curator too: the change answers as if the metric were not there.
      await expect(
        updateMetric(asPerson(salesCurator, { db: tx }), sessions, {
          definition: "Visits.",
        }),
      ).rejects.toMatchObject({ kind: "not_found" });
      const page = await listMetrics(asPerson(viewer, { db: tx }), {
        dataset: datasetId(MARKETING),
      });
      expect(page.items).toEqual([]);
    }));

  it("names in its failing checks only the labels of metrics the caller may see", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const hidden = await draftOf(tx, sample, MARKETING, "Ad spend");
      const shown = await draftOf(tx, sample, SALES, "Return rate");
      await updateMetric(context, hidden, { label: "Zorblax spend" });
      await updateMetric(context, shown, { label: "Zorblax returns" });
      const failing = async (principal: Principal) =>
        JSON.stringify(
          (await getMetric(asPerson(principal, { db: tx }), shown))
            .failing_checks,
        );
      expect(await failing(curator)).toContain("Zorblax spend");
      expect(await failing(viewer)).not.toContain("Zorblax spend");
    }));

  it("finds a key before the metrics that have it as an alias", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const word = "z_key_metrics_test";
      await createMetric(context, { name: word, label: "Key" });
      // Written directly: a curator can no longer give either order, but an older book may hold it.
      for (const letter of ["a", "b", "c", "d", "e", "f"]) {
        await tx.insert(metric).values({
          name: `${letter}_alias_metrics_test`,
          label: "Alias",
          origin: "curator",
          aliases: [word],
        });
      }
      expect((await getMetric(context, word)).label).toBe("Key");
      // In another case it is only an alias, of six metrics.
      await expect(
        getMetric(context, word.toUpperCase()),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));

  it("finds an alias the caller may see past a key it may not", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const hidden = await draftOf(tx, sample, MARKETING, "Sessions");
      const seen = await draftOf(tx, sample, SALES, "Orders");
      // Written directly: a curator can no longer give this, but an older book may hold it.
      await tx
        .update(metric)
        .set({ aliases: [hidden] })
        .where(eq(metric.name, seen));
      const salesOnly = asPerson(salesCurator, { db: tx });
      expect((await getMetric(context, hidden)).name).toBe(hidden);
      expect((await getMetric(salesOnly, hidden)).name).toBe(seen);
    }));

  it("compares a word Postgres lowers apart from JavaScript", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const one = await draftOf(tx, sample, SALES, "Orders");
      const other = await draftOf(tx, sample, MARKETING, "Sessions");
      await updateMetric(context, one, { label: "ΚΟΣΤΟΣ παραγγελίας" });
      await updateMetric(context, other, { label: "ΚΟΣΤΟΣ αποστολής" });
      const { failing_checks } = await getMetric(context, one);
      expect(failing_checks.map((failing) => failing.check)).toContain(
        "metric_not_the_same_as",
      );
    }));
});

describe("summarizeBook", () => {
  it("counts by trust state", () =>
    drafted(async (tx, sample) => {
      const before = await summarizeBook(asPerson(curator, { db: tx }));
      expect(before.metrics.draft).toBeGreaterThan(0);
      expect(before.metrics.agent_verified).toBe(0);
      const name = await draftOf(tx, sample, MARKETING, "Sessions");
      await tx
        .update(metric)
        .set({ trust_state: "agent_verified" })
        .where(eq(metric.name, name));
      const after = await summarizeBook(asPerson(curator, { db: tx }));
      expect(after.metrics.agent_verified).toBe(1);
      expect(after.metrics.draft).toBe(before.metrics.draft - 1);
    }));

  it("counts what no category holds, as the list with not_filed shows it, leaving out the dismissed", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const before = await summarizeBook(context);
      const listed = await listMetrics(context, {
        not_filed: true,
        limit: 500,
      });
      expect(before.not_filed).toBeGreaterThan(0);
      expect(listed.items).toHaveLength(before.not_filed);
      expect(listed.items.every((item) => item.category === null)).toBe(true);
      await tx
        .update(metric)
        .set({ dismissed_at: new Date() })
        .where(
          eq(metric.name, await draftOf(tx, sample, MARKETING, "Sessions")),
        );
      expect((await summarizeBook(context)).not_filed).toBe(
        before.not_filed - 1,
      );

      const filed = await draftOf(tx, sample, MARKETING, "Ad spend");
      await createCategory(
        asPerson(reaching({}, "admin"), { db: tx }),
        "filed_test",
        { name: "Filed test" },
      );
      await updateMetric(context, filed, { category: "filed_test" });
      const names = async (not_filed: boolean) =>
        (await listMetrics(context, { not_filed, limit: 500 })).items.map(
          (item) => item.name,
        );
      expect(await names(true)).not.toContain(filed);
      expect(await names(true)).toHaveLength(before.not_filed - 2);
      expect((await summarizeBook(context)).not_filed).toBe(
        before.not_filed - 2,
      );
      // false is no filter at all, not "only the filed ones".
      expect(await names(false)).toContain(filed);
      expect((await names(false)).length).toBeGreaterThan(
        (await names(true)).length,
      );
    }));
});

describe("listMetrics", () => {
  it("matches normalized key, label and aliases before paging, with literal LIKE characters", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const created = await createMetric(context, {
        name: "sample_filter_key",
        label: "Sample filter label",
        definition: "Sample.",
        aliases: ["Odd%_\\word"],
      });
      for (const name_contains of [
        "FILTER KEY",
        "filter_label",
        "odd% \\word",
      ]) {
        const page = await listMetrics(context, { name_contains, limit: 1 });
        expect(page).toMatchObject({ total: 1, items: [{ id: created.id }] });
      }
      expect(
        (await listMetrics(context, { name_contains: "odd%X" })).items,
      ).toEqual([]);
    }));

  it("counts only datasets the caller may describe", () =>
    drafted(async (tx, sample) => {
      const name = await draftOf(tx, sample, SALES, "Orders");
      expect(await draftOf(tx, sample, MARKETING, "Orders")).toBe(name);
      const [all] = (
        await listMetrics(asPerson(curator, { db: tx }), {
          name_prefix: name,
        })
      ).items;
      const [visible] = (
        await listMetrics(asPerson(viewer, { db: tx }), {
          name_prefix: name,
        })
      ).items;

      expect(all).toMatchObject({ name, dataset_count: 2 });
      expect(visible).toMatchObject({ name, dataset_count: 1 });
      expect(visible?.aliases).toEqual(all?.aliases);
    }));

  it("filters by dataset, workspace and app, and pages by key", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const names = async (filters: Parameters<typeof listMetrics>[1]) =>
        (await listMetrics(context, filters)).items.map((item) => item.name);
      const inSales = await names({ dataset: datasetId(SALES) });
      expect(inSales).toHaveLength(13);
      const inFinance = await names({ workspace: workspaceId(FINANCE) });
      expect(inFinance).toHaveLength(8);
      expect(await names({ app: "Leadership app" })).toEqual(inFinance);
      // A direct share shows Sales, not its app: the app filters as a missing one.
      const shared = asPerson(
        reaching({ powerbi_dataset_ids: [datasetId(SALES)] }),
        { db: tx },
      );
      const sharedNames = async (app: string) =>
        (await listMetrics(shared, { app })).items.map((item) => item.name);
      expect(
        (await listMetrics(shared, { dataset: datasetId(SALES) })).items,
      ).toHaveLength(13);
      for (const app of [
        "Sales app",
        idOf(tenant.apps, "Sales app"),
        "Nothing",
        randomUUID(),
      ])
        expect(await sharedNames(app)).toEqual([]);

      const first = await listMetrics(context, {
        dataset: datasetId(SALES),
        limit: 4,
      });
      expect(first.items).toHaveLength(4);
      const second = await listMetrics(context, {
        dataset: datasetId(SALES),
        limit: 9,
        cursor: first.next_cursor ?? "",
      });
      expect(second.next_cursor).toBeNull();
      expect([...first.items, ...second.items].map((i) => i.name)).toEqual(
        inSales,
      );
      expect(
        await names({ dataset: datasetId(SALES), origin: "curator" }),
      ).toEqual([]);
    }));

  it("filters by category with or without its children, unit, trust state and custom fields", () =>
    drafted(async (tx) => {
      const admin = asPerson(reaching({}, "admin"), { db: tx });
      await setConventionsAsAdmin(admin, {
        metric_fields: {
          custom: [{ key: "owner_team", label: "Owner team", type: "text" }],
        },
      });
      await createCategory(admin, "metrics_test", { name: "Metrics test" });
      await createCategory(admin, "metrics_test/orders", { name: "Orders" });
      const context = asPerson(curator, { db: tx });
      await createMetric(context, {
        name: "number_of_parent_metrics_test",
        label: "Number of parent",
        unit: "count",
        category: "metrics_test",
      });
      await createMetric(context, {
        name: "total_child_metrics_test",
        label: "Total child",
        definition: "Sample definition ".repeat(30),
        unit: "money",
        category: "metrics_test/orders",
        custom: { owner_team: "finance" },
      });
      const names = async (filters: Parameters<typeof listMetrics>[1]) =>
        (await listMetrics(context, filters)).items.map((item) => item.name);
      expect(await names({ category: "metrics_test" })).toEqual([
        "number_of_parent_metrics_test",
      ]);
      expect(
        await names({ category: "metrics_test", include_children: true }),
      ).toEqual(["number_of_parent_metrics_test", "total_child_metrics_test"]);
      const prefix = { name_prefix: "TOTAL_CHILD_METRICS" };
      expect(await names({ ...prefix, unit: "count" })).toEqual([]);
      expect(await names({ ...prefix, unit: "money" })).toHaveLength(1);
      expect(
        await names({ ...prefix, custom: { owner_team: "finance" } }),
      ).toHaveLength(1);
      expect(
        await names({ ...prefix, trust_states: ["agent_verified"] }),
      ).toEqual([]);
      const [item] = (await listMetrics(context, prefix)).items;
      expect(item?.summary.length).toBeLessThanOrEqual(240);
      expect(item?.summary).toMatch(/definition…$/u);
      expect(item?.summary_truncated).toBe(true);
      expect(item).toMatchObject({
        kind: "metric",
        category: { kind: "category", path: "metrics_test/orders" },
        trust_state: "draft",
        origin: "curator",
        dismissed: false,
        custom: { owner_team: "finance" },
      });
      await expect(
        listMetrics(context, { category: "no_such_category" }),
      ).rejects.toMatchObject({ kind: "not_found" });
    }));
});

/** The book changes and events about one metric; others' commits are not a test's business. */
async function recorded(tx: Db, metricId: string) {
  const changes = await tx
    .select()
    .from(bookChange)
    .where(
      and(
        eq(bookChange.element_kind, "metric"),
        eq(bookChange.element_id, metricId),
      ),
    )
    .orderBy(asc(bookChange.id));
  const events = await tx
    .select({ kind: event.kind, data: event.data })
    .from(event)
    .where(
      and(eq(event.element_kind, "metric"), eq(event.element_id, metricId)),
    )
    .orderBy(asc(event.id));
  return { changes, events };
}

describe("creating and changing a metric", () => {
  it("creates, updates, renames, dismisses and deletes, recording each change", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const created = await createMetric(context, {
        name: " number_of_widgets_metrics_test ",
        label: "Number of widgets",
        unit: "count",
      });
      expect(created).toMatchObject({
        name: "number_of_widgets_metrics_test",
        origin: "curator",
        trust_state: "draft",
        aliases: null,
        base_variants: [],
      });
      expect(created.touched_at).not.toBeNull();

      await updateMetric(context, created.name, {
        aliases: ["Widget count"],
        definition: "How many widgets were made.",
      });
      // An alias finds it, in any case.
      expect((await getMetric(context, "WIDGET COUNT")).id).toBe(created.id);
      await updateMetric(context, created.name, { unit: "count" });

      const renamed = await renameMetric(
        context,
        created.id,
        "total_widgets_metrics_test",
      );
      expect(renamed.name).toBe("total_widgets_metrics_test");
      await expect(
        getMetric(context, "number_of_widgets_metrics_test"),
      ).rejects.toMatchObject({ kind: "not_found" });

      await dismissMetric(context, renamed.name, " Not a metric. ");
      const prefix = { name_prefix: "total_widgets_metrics" };
      expect((await listMetrics(context, prefix)).items).toEqual([]);
      const [dismissed] = (
        await listMetrics(context, { ...prefix, dismissed: true })
      ).items;
      expect(dismissed?.dismissed).toBe(true);

      const history = await metricHistory(context, renamed.name);
      expect(history.map((row) => row.action)).toEqual([
        "create",
        "update",
        "rename",
        "dismiss",
      ]);
      expect(history[2]).toMatchObject({
        via: "browser",
        before: { name: "number_of_widgets_metrics_test" },
        after: { name: "total_widgets_metrics_test" },
      });

      await deleteMetric(context, renamed.name);
      const { changes, events } = await recorded(tx, created.id);
      expect(changes.at(-1)).toMatchObject({ action: "delete", after: null });
      expect(events.map((row) => [row.kind, row.data.action])).toEqual([
        ["metric.created", "create"],
        ["metric.changed", "update"],
        ["metric.changed", "rename"],
        ["metric.changed", "dismiss"],
        ["metric.changed", "delete"],
      ]);
      expect(events[2]?.data).toMatchObject({
        previous_name: "number_of_widgets_metrics_test",
      });
    }));

  it("refuses what the conventions do not allow, a taken key, and a delete while variants remain", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const draft = await draftOf(tx, sample, SALES, "Orders");
      const refusals: [() => Promise<unknown>, string][] = [
        [() => createMetric(context, { name: draft, label: "x" }), "conflict"],
        [() => createMetric(context, { name: " ", label: "x" }), "invalid"],
        [() => updateMetric(context, draft, { unit: "furlongs" }), "invalid"],
        [() => updateMetric(context, draft, { custom: { x: 1 } }), "invalid"],
        [() => updateMetric(context, draft, { aliases: [" "] }), "invalid"],
        [() => updateMetric(context, draft, { category: "none" }), "not_found"],
        [() => dismissMetric(context, draft, " "), "invalid"],
        [() => deleteMetric(context, draft), "conflict"],
      ];
      for (const [attempt, kind] of refusals) {
        await expect(attempt()).rejects.toMatchObject({ kind });
      }
      const units = await draftOf(tx, sample, SALES, "Units sold");
      await expect(renameMetric(context, units, draft)).rejects.toMatchObject({
        kind: "conflict",
      });
    }));

  it("counts only the variants it may describe when it refuses a delete", () =>
    drafted(async (tx, sample) => {
      const draft = await draftOf(tx, sample, SALES, "Net sales");
      const all = await getMetric(asPerson(curator, { db: tx }), draft);
      const context = asPerson(salesCurator, { db: tx });
      const refusal = deleteMetric(context, draft);
      await expect(refusal).rejects.toThrow("some you cannot see");
      const total =
        all.base_variants.length +
        all.other_variants.reduce((n, o) => n + o.count, 0);
      await expect(refusal).rejects.not.toThrow(`${String(total)} variants`);
    }));

  it("touches a sync draft on its first change, keeps its origin, and confirms a generated key", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const name = await draftOf(tx, sample, SALES, "Return rate");
      expect((await getMetric(context, name)).touched_at).toBeNull();
      const confirmed = await renameMetric(context, name, name);
      expect(confirmed).toMatchObject({
        origin: "sync",
        name_is_generated: false,
      });
      expect(confirmed.touched_at).not.toBeNull();
      expect(confirmed.failing_checks.map((f) => f.check)).not.toContain(
        "metric_name_generated",
      );
    }));

  it("refuses every change to a viewer", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(viewer, { db: tx });
      const name = await draftOf(tx, sample, SALES, "Net sales");
      const other = await draftOf(tx, sample, SALES, "Return rate");
      const attempts = [
        () => createMetric(context, { name: "total_metrics_test", label: "x" }),
        () => updateMetric(context, name, { definition: "x" }),
        () => renameMetric(context, name, "total_metrics_test"),
        () => dismissMetric(context, name, "x"),
        () => deleteMetric(context, name),
        () => mergeMetrics(context, { from: other, into: name }),
        () => verifyMetric(context, name),
        () => approveMetric(context, name),
        () => metricHistory(context, name),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ kind: "refused" });
      }
    }));
});

describe("mergeMetrics", () => {
  it("keeps a sync's other the sync's through a merge, so later copies still gather under it", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const orders = await draftOf(tx, sample, SALES, "Orders");
      const count = await draftOf(tx, sample, FINANCE, "Order count");
      const measure_id = sample.measureId({
        dataset: FINANCE,
        measure: "Order count",
      });
      await tx
        .update(metricVariant)
        .set({ period: "other" })
        .where(eq(metricVariant.measure_id, measure_id));
      await updateMetric(context, orders, { unit: "count" });
      await updateMetric(context, count, { unit: "count" });
      await mergeMetrics(context, { from: count, into: orders });
      expect(
        (
          await tx
            .select()
            .from(metricVariant)
            .where(eq(metricVariant.measure_id, measure_id))
        )[0],
      ).toMatchObject({ period: "other", assigned_by: "sync" });
    }));

  it("moves every variant and deletes the emptied metric, once the units agree", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const orders = await draftOf(tx, sample, SALES, "Orders");
      const count = await draftOf(tx, sample, FINANCE, "Order count");
      const merge = () => mergeMetrics(context, { from: count, into: orders });

      // A unit against none is refused too: the agent sets the draft's unit first.
      await updateMetric(context, orders, { unit: "count" });
      await expect(merge()).rejects.toMatchObject({ kind: "conflict" });
      await updateMetric(context, count, { unit: "money" });
      await expect(merge()).rejects.toMatchObject({ kind: "conflict" });
      await updateMetric(context, count, { unit: "count" });
      const countId = (await getMetric(context, count)).id;

      const merged = await merge();
      expect(merged.base_variants.map((base) => base.measure.name)).toEqual([
        "Orders",
        "Orders",
        "Order count",
      ]);
      await expect(getMetric(context, count)).rejects.toMatchObject({
        kind: "not_found",
      });
      const [moved] = await tx
        .select()
        .from(metricVariant)
        .where(
          eq(
            metricVariant.measure_id,
            sample.measureId({ dataset: FINANCE, measure: "Order count" }),
          ),
        );
      // A merge moves the variant, not its filing: the sync's stays the sync's.
      expect(moved).toMatchObject({
        metric_id: merged.id,
        assigned_by: "sync",
      });
      const announced = await tx
        .select({ kind: event.kind, data: event.data })
        .from(event)
        .where(
          and(
            eq(event.element_kind, "variant"),
            eq(event.element_id, moved?.id ?? ""),
            // The drafter announced the measure's first filing too.
            eq(event.principal_id, curator.id),
          ),
        );
      expect(announced).toEqual([
        {
          kind: "variant.moved",
          data: {
            measure_id: moved?.measure_id,
            from_metric_id: countId,
            to_metric_id: merged.id,
            dataset_id: datasetId(FINANCE),
          },
        },
      ]);
      const gone = await recorded(tx, countId);
      expect(gone.changes.at(-1)).toMatchObject({
        action: "merge",
        after: null,
      });
    }));

  it("refuses a variant whose shift the target already holds in the same dataset, naming both", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curator, { db: tx });
      const returns = await draftOf(tx, sample, SALES, "Return rate");
      const net = await draftOf(tx, sample, SALES, "Net sales");
      await expect(
        mergeMetrics(context, { from: returns, into: net }),
      ).rejects.toMatchObject({
        kind: "conflict",
        detail: { clashes: [`Return rate and Net sales in ${SALES}`] },
      });
      // A measure read as time-shifted holds `other`, which clashes with no base.
      const web = await draftOf(tx, sample, SALES, "Web net sales LY");
      await expect(
        mergeMetrics(context, { from: web, into: net }),
      ).resolves.toMatchObject({ name: net });
      await expect(
        mergeMetrics(context, { from: net, into: net }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }));

  it("names only the clashes in datasets the caller may describe and counts the rest", () =>
    drafted(async (tx, sample) => {
      const usd = await draftOf(tx, sample, FINANCE, "Revenue USD");
      const returns = await draftOf(tx, sample, SALES, "Return rate");
      const net = await draftOf(tx, sample, SALES, "Net sales");
      const revenue = await draftOf(tx, sample, FINANCE, "Revenue");
      // A base variant in Sales and one in Finance, each clashing with Net sales' own.
      await mergeMetrics(asPerson(curator, { db: tx }), {
        from: revenue,
        into: net,
      });
      await mergeMetrics(asPerson(curator, { db: tx }), {
        from: usd,
        into: returns,
      });
      const refusal: unknown = await mergeMetrics(
        asPerson(salesCurator, { db: tx }),
        { from: returns, into: net },
      ).catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        kind: "conflict",
        detail: {
          clashes: [`Return rate and Net sales in ${SALES}`],
          hidden: 1,
        },
      });
      const told = `${String(refusal)} ${JSON.stringify(refusal)}`;
      expect(told).toContain(
        `Return rate and Net sales in ${SALES}, and 1 more clash you cannot see.`,
      );
      expect(told).not.toMatch(/Revenue|Finance/);
    }));
});

/** The Units sold draft, structured so that every check under the default conventions passes. */
async function passing(tx: Db, sample: SampleMirror): Promise<string> {
  const context = asPerson(curator, { db: tx });
  await createCategory(
    asPerson(reaching({}, "admin"), { db: tx }),
    "metrics_test",
    {
      name: "Metrics test",
    },
  );
  const name = "number_of_units_sold";
  await renameMetric(
    context,
    await draftOf(tx, sample, SALES, "Units sold"),
    name,
  );
  await updateMetric(context, name, {
    label: "Number of units sold",
    definition: "How many units were sold.",
    tier: "driver",
    importance: "medium",
    direction: "higher_is_better",
    use_for: "Plan capacity.",
    dont_use_for: "Profitability.",
    decisions: "Adjust capacity.",
    owner_team: "Operations",
    aliases: [],
    when_to_use: "To count volume.",
    not_the_same_as: "Not the number of orders.",
    grain_and_filters: "Order lines, all channels.",
    unit: "quantity",
    category: "metrics_test",
  });
  return name;
}

describe("trust", () => {
  it("follows the transitions table for a token's change and a browser's", () =>
    drafted(async (tx, sample) => {
      const name = await passing(tx, sample);
      const browser = asPerson(curator, { db: tx });
      const agent = asPerson(token(curator), { db: tx });
      let edits = 0;
      const edit = async (by: typeof browser, definition?: string) =>
        (
          await updateMetric(by, name, {
            definition: definition ?? `Units sold, edit ${String(++edits)}.`,
          })
        ).trust_state;

      expect(await edit(agent)).toBe("draft");
      await verifyMetric(agent, name);
      expect(await edit(agent)).toBe("draft");
      await verifyMetric(agent, name);
      expect(await edit(browser)).toBe("agent_verified");
      const refusal: unknown = await approveMetric(agent, name).then(
        () => {
          throw new Error("The agent's approval unexpectedly succeeded");
        },
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ kind: "refused" });
      if (!(refusal instanceof Error))
        throw new Error("The agent's refusal was not an Error");
      expect(refusal.message).toContain(`/catalog/metrics/${name}`);
      await approveMetric(browser, name);
      expect(await edit(browser)).toBe("human_verified");
      expect(await edit(agent)).toBe("agent_verified");
      expect((await getMetric(browser, name)).verified_by).toBe(curator.id);
      await approveMetric(browser, name);
      // Blanking a required field fails metric_fields, so a person looks again.
      expect(await edit(agent, "")).toBe("draft");
      expect(await getMetric(browser, name)).toMatchObject({
        verified_by: null,
        verified_at: null,
      });
      const { events } = await recorded(
        tx,
        (await getMetric(browser, name)).id,
      );
      expect(events.map((row) => row.kind)).toContain("metric.approved");
      expect(events.map((row) => row.kind)).toContain("metric.verified");
    }));

  it("refuses to verify or approve while a check fails, listing the failures", () =>
    drafted(async (tx, sample) => {
      const name = await draftOf(tx, sample, SALES, "Average order value");
      for (const promote of [verifyMetric, approveMetric]) {
        const refusal = promote(asPerson(curator, { db: tx }), name);
        await expect(refusal).rejects.toMatchObject({ kind: "invalid" });
        await expect(refusal).rejects.toThrow(/metric_name_generated/);
      }
      const read = await getMetric(asPerson(curator, { db: tx }), name);
      expect(read).toMatchObject({ trust_state: "draft", touched_at: null });
    }));

  it("names the principal whose change set verified_by, not a later editor of the same id", () =>
    drafted(async (tx, sample) => {
      const name = await passing(tx, sample);
      // A service account named like a person's id verifies; the person then edits in the browser.
      const shared = "forged-verifier";
      await tx.insert(user).values({
        id: shared,
        name: "Real person",
        email: "real@sample.example",
      });
      const agent = asPerson(
        { ...token(curator), kind: "service_account", id: shared },
        { db: tx },
      );
      const person = asPerson({ ...curator, id: shared }, { db: tx });
      await verifyMetric(agent, name);
      await updateMetric(person, name, { definition: "Edited by the person." });
      const read = await getMetric(person, name);
      expect(read.verified_by).toBe(shared);
      // No service account of that name exists, and the person did not verify.
      expect(read.verified_by_name).toBe("a removed person");
    }));

  it("verifies against only the checks trust.agent_verify_requires names", () =>
    drafted(async (tx, sample) => {
      await setConventionsAsAdmin(asPerson(reaching({}, "admin"), { db: tx }), {
        trust: {
          agent_verify_requires: ["metric_base_variant"],
          human_verify_from: "browser",
        },
      });
      const name = await draftOf(tx, sample, SALES, "Average order value");
      const verified = await verifyMetric(
        asPerson(token(curator), { db: tx }),
        name,
      );
      expect(verified).toMatchObject({
        trust_state: "agent_verified",
        verified_by: curator.id,
      });
      expect(verified.touched_at).not.toBeNull();
    }));

  it("fails a required check as a whole when any one of its rules fails, and names that rule", () =>
    drafted(async (tx, sample) => {
      await setConventionsAsAdmin(asPerson(reaching({}, "admin"), { db: tx }), {
        trust: {
          agent_verify_requires: ["metric_fields"],
          human_verify_from: "browser",
        },
      });
      const name = await draftOf(tx, sample, SALES, "Average order value");
      const context = asPerson(token(curator), { db: tx });
      // The draft has no definition: metric_fields.definition fails, though most of its other rules pass.
      await expect(verifyMetric(context, name)).rejects.toThrow(
        /metric_fields\.definition: Fill in definition/,
      );
      await updateMetric(context, name, {
        definition: "The average net sales of one order.",
        aliases: [],
        when_to_use: "To see if customers spend more each time.",
        grain_and_filters: "One order.",
        unit: "money",
      });
      // Every rule but the category passes; the one failing rule still fails the check.
      await expect(verifyMetric(context, name)).rejects.toThrow(
        /metric_fields\.category/,
      );
    }));

  it("passes metric_base_variant for a metric holding only other, not one holding only a proven shift", () =>
    drafted(async (tx, sample) => {
      await setConventionsAsAdmin(asPerson(reaching({}, "admin"), { db: tx }), {
        trust: {
          agent_verify_requires: ["metric_base_variant"],
          human_verify_from: "browser",
        },
      });
      const name = await draftOf(tx, sample, SALES, "Average order value");
      const context = asPerson(token(curator), { db: tx });
      const filed = (period: string) =>
        tx
          .update(metricVariant)
          .set({ period })
          .where(
            eq(
              metricVariant.measure_id,
              sample.measureId({
                dataset: SALES,
                measure: "Average order value",
              }),
            ),
          );
      await filed("previous_year");
      await expect(verifyMetric(context, name)).rejects.toThrow(
        /metric_base_variant/,
      );
      await filed("other");
      expect(await verifyMetric(context, name)).toMatchObject({
        trust_state: "agent_verified",
      });
    }));

  it("verifies and approves against every other label, even one the database lowers apart from Node", () =>
    drafted(async (tx, sample) => {
      const name = await passing(tx, sample);
      const browser = asPerson(curator, { db: tx });
      // Node lowers these Unicode 17 capitals, and glibc 2.41 does not, so ilike misses them.
      await updateMetric(browser, name, {
        label: "Number of \u{16EBB}\u{16EBC}",
        not_the_same_as: null,
      });
      const sameWord = await draftOf(tx, sample, SALES, "Average order value");
      const failing = async () =>
        (await metricChecks(browser, name))
          .filter((check) => !check.passed)
          .map((check) => check.check);
      expect(await failing()).toEqual([]);
      await updateMetric(browser, sameWord, {
        label: "Total \u{16EA0}\u{16EA1}",
      });
      expect(await failing()).toEqual(["metric_not_the_same_as"]);
      for (const promote of [verifyMetric, approveMetric]) {
        await expect(promote(browser, name)).rejects.toThrow(
          /metric_fields\.not_the_same_as/,
        );
      }
    }));
});
