import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import { inSampleMirror, setRole } from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { draftDatasets } from "./drafter.js";
import { nextDrafts } from "./drafts.js";
import { createMetric, updateMetric } from "./metrics.js";
import { listVariants, moveVariant } from "./variants.js";

afterAll(closeTestPools);

/*
 * Each test drafts the sample mirror under the default conventions and acts
 * as the api in a transaction that is rolled back, as metrics.test.ts does.
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

/** The sample's Admin, as a curator: every workspace. */
const curator = reaching(
  { powerbi_workspace_ids: [SALES, FINANCE, MARKETING].map(workspaceId) },
  "curator",
);
/** The Analyst, as a curator: the Sales workspace only. */
const salesCurator = reaching(
  { powerbi_workspace_ids: [workspaceId(SALES)] },
  "curator",
);
/** The Viewer: the Sales app. */
const viewer = reaching({
  powerbi_app_ids: [idOf(tenant.apps, "Sales app")],
});

const drafted = (work: (tx: Db) => Promise<void>) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draftDatasets(
      createTestDeps({ container: "worker", db: tx }),
      sample.tenant.datasets.map((dataset) => dataset.id),
    );
    await setRole(tx, "api_rw");
    await work(tx);
  });

/** The draft in the queue that holds the measure. */
const holding = (queue: Awaited<ReturnType<typeof nextDrafts>>, name: string) =>
  queue.find((d) => d.variants.some((v) => v.measure.name === name));

describe("nextDrafts", () => {
  it("orders the drafts by how many datasets hold them, then by size, and leaves out touched and dismissed ones", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const queue = await nextDrafts(context, { limit: 50 });
      const net = holding(queue, "Net sales")?.name ?? "";
      const lines = holding(queue, "Order lines LM")?.name;
      const orders = holding(queue, "Orders")?.name;
      expect(queue.slice(0, 4).map((d) => [d.name, d.dataset_count])).toEqual([
        [net, 2],
        [lines, 2],
        [orders, 2],
        [expect.any(String), 1],
      ]);
      expect(holding(queue, "_Report title")).toBeUndefined();
      const sizes = queue
        .filter((d) => d.dataset_count === 1)
        .map((d) => d.variants.length);
      expect(sizes).toEqual(sizes.toSorted((a, b) => b - a));

      await updateMetric(context, net, { definition: "Sales after returns." });
      const [first] = await nextDrafts(context, { limit: 1 });
      expect(first?.name).toBe(lines);
    }));

  it("gives each draft its variants with their DAX, its datasets, the closest metrics and the likely merges", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      await createMetric(context, {
        name: "total_net_sales_excl_vat",
        label: "Total net sales excl VAT",
      });
      const queue = await nextDrafts(context, { dataset: FINANCE });
      expect(holding(queue, "Orders")).toBeUndefined();
      const found = holding(queue, "Revenue");
      expect(found?.datasets.map((d) => d.name)).toEqual([FINANCE]);
      expect(found?.hidden_variants).toBe(0);
      const revenue = found?.variants.find((v) => v.measure.name === "Revenue");
      const measure = tenant.datasets
        .flatMap((d) => d.tables.flatMap((table) => table.measures))
        .find((m) => m.name === "Revenue");
      expect(revenue).toMatchObject({
        kind: "variant",
        dataset: { name: FINANCE },
        measure_reference: "[Revenue]",
        expression: measure?.expression,
        shift: { period: "current", comparison: "none", currency: null },
      });
      const net = holding(
        await nextDrafts(context, { limit: 50 }),
        "Net sales",
      );
      expect(net?.datasets.map((d) => d.name)).toEqual([MARKETING, SALES]);
      expect(net?.closest_metrics.map((m) => m.name)).toContain(
        "total_net_sales_excl_vat",
      );
      expect(found?.suggested_merges).toContainEqual(
        expect.objectContaining({
          measure: "Revenue",
          word: null,
          axis: "calculation",
        }),
      );
      expect(found?.suggested_merges).toContainEqual(
        expect.objectContaining({
          measure: "Revenue USD",
          into_measure: "Revenue",
          word: "USD",
          axis: "currency",
        }),
      );
    }));

  it("names only what the caller may describe and counts the rest", () =>
    drafted(async (tx) => {
      const context = asPerson(salesCurator, { db: tx });
      const queue = await nextDrafts(context, { limit: 50 });
      expect(holding(queue, "Net sales")).toMatchObject({
        dataset_count: 2,
        datasets: [{ name: SALES }],
        hidden_variants: 1,
        hidden_suggested_merges: 3,
      });
      // Sales and Retail each hold Net sales under a metric of their own, so each pair of metrics is an entry.
      expect(
        holding(queue, "Net sales")
          ?.suggested_merges.map(
            ({ measure, into_measure, dataset_count }) =>
              `${measure} -> ${into_measure} in ${String(dataset_count)}`,
          )
          .sort(),
      ).toEqual(
        [
          "Net sales -> Net sales in 1",
          "Net sales LY -> Net sales in 1",
          "Net sales LY -> Net sales in 1",
          "Net sales LY YTD -> Net sales LY in 1",
          "Net sales LY YTD -> Net sales YTD in 1",
          "Net sales MTD -> Net sales in 1",
          "Net sales MTD -> Net sales in 1",
          "Net sales QTD -> Net sales in 1",
          "Net sales YTD -> Net sales in 1",
          "Net sales YTD -> Net sales in 1",
        ].sort(),
      );
      expect(JSON.stringify(queue)).not.toMatch(/Revenue|Finance|Marketing/);
      const closest = (measure: string) =>
        holding(queue, measure)?.closest_metrics.map((m) => m.name);
      // Close by name, but drafts of Finance and Marketing only.
      expect(closest("Orders")).not.toContain("order_count");
      expect(closest("Return rate")).not.toContain("return_on_ad_spend");
      expect(await nextDrafts(context, { dataset: FINANCE })).toEqual([]);
      expect(await nextDrafts(context, { dataset: "Nowhere" })).toEqual([]);
    }));

  it("gives a curator who reaches a dataset only through an app the drafts held there", () =>
    drafted(async (tx) => {
      const appCurator = reaching(
        { powerbi_app_ids: [idOf(tenant.apps, "Sales app")] },
        "curator",
      );
      const queue = await nextDrafts(asPerson(appCurator, { db: tx }), {
        limit: 50,
      });
      expect(queue.length).toBeGreaterThan(0);
      expect(holding(queue, "Net sales")?.datasets.map((d) => d.name)).toEqual([
        SALES,
      ]);
      expect(JSON.stringify(queue)).not.toMatch(/Finance|Marketing/);
      expect(
        await nextDrafts(asPerson(appCurator, { db: tx }), {
          dataset: FINANCE,
        }),
      ).toEqual([]);
    }));

  it("gives each draft its own closest metrics, the closest first and itself never", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      for (const [name, label] of [
        ["net_sales_close", "Net sales close"],
        ["orders_close", "Orders close"],
      ] as const) {
        await createMetric(context, { name, label });
      }
      const queue = await nextDrafts(context, { limit: 50 });
      const closest = (measure: string) =>
        holding(queue, measure)?.closest_metrics ?? [];
      expect(closest("Net sales").map((m) => m.name)).toContain(
        "net_sales_close",
      );
      expect(closest("Net sales").map((m) => m.name)).not.toContain(
        "orders_close",
      );
      expect(closest("Orders").map((m) => m.name)).toContain("orders_close");
      for (const draft of queue) {
        const names = draft.closest_metrics.map((m) => m.name);
        const scores = draft.closest_metrics.map((m) => m.similarity);
        expect(names).not.toContain(draft.name);
        expect(names.length).toBeLessThanOrEqual(5);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      }
    }));

  it("gives an agent what it needs to act on a likely merge", () =>
    drafted(async (tx) => {
      const context = asPerson(curator, { db: tx });
      const queue = await nextDrafts(context, { limit: 50 });
      const usd = queue
        .flatMap((draft) => draft.suggested_merges)
        .find((merge) => merge.measure === "Revenue USD");
      if (usd === undefined) throw new Error("Revenue USD is not suggested.");
      const held = await listVariants(context, usd.metric_id);
      const found = held.items.filter((v) => v.measure.name === usd.measure);
      expect(found).toHaveLength(usd.dataset_count);
      for (const { id } of found) {
        await moveVariant(context, id, {
          to_metric: usd.into_metric_id,
          currency: usd.word,
        });
      }
      const after = await listVariants(context, usd.into_metric_id);
      expect(after.items.map((v) => v.measure.name)).toContain("Revenue USD");
    }));

  it("refuses a viewer", () =>
    drafted(async (tx) => {
      await expect(
        nextDrafts(asPerson(viewer, { db: tx })),
      ).rejects.toMatchObject({ kind: "refused" });
    }));
});
