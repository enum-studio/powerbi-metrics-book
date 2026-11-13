import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { bookChange, metric, metricVariant } from "../../db/schema/book.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { powerbiDataset, powerbiMeasure } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import type { Principal } from "../../principal.js";
import { setEnabled } from "../admin/datasets.js";
import { handlerFor } from "../jobs/registry.js";
import "../sync/run.js";
import { setConventions } from "../conventions/store.js";
import { readVisibleEvents } from "../events/feed.js";
import { collectDocuments } from "../search/documents.js";
import { removeDatasets } from "../sync/store.js";
import { draftDatasets, removedDatasetsInDrafts } from "./drafter.js";
import {
  createMetric,
  getMetric,
  listMetrics,
  mergeMetrics,
  renameMetric,
  updateMetric,
} from "./metrics.js";
import { suggestSameNames } from "./suggestions.js";
import { moveVariant } from "./variants.js";

/*
 * A draft's key and label reach everyone who may see one of its variants, so
 * they may come only from what each of those readers may see. On the sample
 * tenant Sales and Marketing call one calculation Net sales and Finance calls
 * it Revenue: a reader of Finance alone must never learn the words Net sales.
 */

afterAll(closeTestPools);

const REVENUE = { dataset: "Finance", measure: "Revenue" };
const RETAIL_ORDERS = { dataset: "Retail", measure: "Orders" };
const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };
const markPii = (tx: Db, table: string, name: string) =>
  tx
    .insert(piiRule)
    .values({ kind: "measure", table_name: table, name, pii: true, ...by });

/** Written apart from the drafter's, so this test fails when the drafter changes its mind. */
const keyOf = (name: string) =>
  name
    .replaceAll("%", " percent ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .join("_");

const datasetId = (sample: SampleMirror, name: string) => {
  const found = sample.tenant.datasets.find((each) => each.name === name);
  if (found === undefined) throw new Error(`The sample has no ${name}`);
  return found.id;
};

const readerOf = (sample: SampleMirror, ...names: string[]): Principal =>
  reaching({
    powerbi_dataset_ids: names.map((name) => datasetId(sample, name)),
  });

/** Runs the drafter as the worker does, in the given order of datasets, and leaves the role as the api's. */
async function draft(tx: Db, ids: string[]): Promise<void> {
  await setRole(tx, "worker_rw");
  await draftDatasets(createTestDeps({ container: "worker", db: tx }), ids);
  await setRole(tx, "api_rw");
}

const allOf = (sample: SampleMirror) =>
  sample.tenant.datasets.map((dataset) => dataset.id);

const drafted = (
  work: (tx: Db, sample: SampleMirror) => Promise<void>,
  order: (ids: string[]) => string[] = (ids) => ids,
) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draft(tx, order(allOf(sample)));
    await work(tx, sample);
  });

/** A new measure beside `beside`, in its table. Leaves the role as the api's. */
async function addMeasure(
  tx: Db,
  sample: SampleMirror,
  beside: { dataset: string; measure: string },
  added: { name: string; expression: string },
): Promise<string> {
  await setRole(tx, "worker_rw");
  const [next] = await tx
    .select()
    .from(powerbiMeasure)
    .where(eq(powerbiMeasure.id, sample.measureId(beside)));
  if (next === undefined) throw new Error(`No ${beside.measure}`);
  const [row] = await tx
    .insert(powerbiMeasure)
    .values({ dataset_id: next.dataset_id, table_id: next.table_id, ...added })
    .returning();
  await setRole(tx, "api_rw");
  if (row === undefined) throw new Error(`${added.name} was not added`);
  return row.id;
}

const metricHolding = async (tx: Db, measureId: string) => {
  const [row] = await tx
    .select({ metric })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(eq(metricVariant.measure_id, measureId));
  if (row === undefined) throw new Error(`No metric holds ${measureId}`);
  return row.metric;
};

/** Every key and label the reader's list holds. */
async function seenBy(tx: Db, principal: Principal) {
  const context = asPerson(principal, { db: tx });
  const { items, next_cursor } = await listMetrics(context, {
    limit: 500,
    dismissed: true,
  });
  expect(next_cursor).toBeNull();
  return { context, items };
}

const namesSeenBy = async (tx: Db, principal: Principal) =>
  (await seenBy(tx, principal)).items.flatMap(({ name, label }) => [
    name,
    label,
  ]);

describe("a draft's name on the sample tenant", () => {
  const forwards = (ids: string[]) => ids;
  const backwards = (ids: string[]) => ids.toReversed();

  it.each([
    ["the tenant's order", forwards],
    ["the reverse order", backwards],
  ])(
    "shows a reader of one dataset only names of the measures they see, drafted in %s",
    (_order, order) =>
      drafted(async (tx, sample) => {
        const readers = sample.tenant.datasets.map(({ name }) =>
          readerOf(sample, name),
        );
        for (const reader of readers) {
          const { context, items } = await seenBy(tx, reader);
          for (const { id, name, label } of items) {
            const { base_variants } = await getMetric(context, id);
            const own = base_variants.map((b) => keyOf(b.measure.name));
            // A second draft of one name takes `_2`, so the key is matched without it.
            expect(own).toContain(keyOf(label));
            expect(name).toMatch(
              new RegExp(`^${keyOf(label)}(_[0-9]+)?$`, "u"),
            );
          }
        }
      }, order),
  );

  it.each([
    ["the tenant's order", forwards],
    ["the reverse order", backwards],
  ])(
    "gives a reader of Finance nothing that says Net sales, drafted in %s",
    (_order, order) =>
      drafted(async (tx, sample) => {
        const reader = readerOf(sample, "Finance");
        const { context, items } = await seenBy(tx, reader);
        expect(
          items.filter((item) => /net.?sales/iu.test(item.name + item.label)),
        ).toEqual([]);
        await expect(getMetric(context, "net_sales")).rejects.toMatchObject({
          kind: "not_found",
        });
        expect(
          await listMetrics(context, { name_prefix: "net" }),
        ).toMatchObject({ items: [] });
        const revenue = await getMetric(context, "revenue");
        expect(revenue.label).toBe("Revenue");
        expect(revenue.base_variants.map((b) => b.measure.name)).toEqual([
          "Revenue",
        ]);

        // Search and the feed carry the same words: a variant's document names its metric.
        await setRole(tx, "worker_rw");
        const documents = await collectDocuments(tx);
        await setRole(tx, "api_rw");
        const finance = datasetId(sample, "Finance");
        expect(
          documents.filter(
            (document) =>
              document.dataset_ids?.includes(finance) === true &&
              /net.?sales/iu.test(
                `${document.name} ${document.label} ${document.search_text}`,
              ),
          ),
        ).toEqual([]);
        const events = await readVisibleEvents(context, {
          kinds: ["draft.created"],
        });
        expect(events.length).toBeGreaterThan(0);
        expect(
          events.filter((row) => /net.?sales/iu.test(String(row.data.name))),
        ).toEqual([]);
      }, order),
  );

  it("keeps one name's copies of a calculation together, whoever reads them", () =>
    drafted(async (tx, sample) => {
      const sales = sample.measureId({
        dataset: "Sales",
        measure: "Net sales",
      });
      const marketing = sample.measureId({
        dataset: "Marketing",
        measure: "Net Sales",
      });
      expect((await metricHolding(tx, sales)).id).toBe(
        (await metricHolding(tx, marketing)).id,
      );
      expect((await metricHolding(tx, sales)).name).toBe("net_sales");
    }));

  it("takes a measure out of an older draft named from a dataset its reader cannot see", () =>
    drafted(async (tx, sample) => {
      const revenue = sample.measureId({
        dataset: "Finance",
        measure: "Revenue",
      });
      const named = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Net sales" }),
      );
      // As an earlier drafter left it: Revenue filed as a base of Net sales' draft.
      await setRole(tx, "worker_rw");
      await tx
        .update(metricVariant)
        .set({ metric_id: named.id })
        .where(eq(metricVariant.measure_id, revenue));
      await draft(tx, allOf(sample));

      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        "net_sales",
      );
    }));

  it("takes no name from a measure that left Power BI", () =>
    drafted(async (tx, sample) => {
      const revenue = sample.measureId({
        dataset: "Finance",
        measure: "Revenue",
      });
      const named = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Net sales" }),
      );
      await setRole(tx, "worker_rw");
      await tx
        .update(metricVariant)
        .set({ metric_id: named.id })
        .where(eq(metricVariant.measure_id, revenue));
      await tx
        .update(powerbiMeasure)
        .set({ removed_at: new Date() })
        .where(
          eq(
            powerbiMeasure.id,
            sample.measureId({ dataset: "Sales", measure: "Net sales" }),
          ),
        );
      await draft(tx, [datasetId(sample, "Finance")]);
      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
    }));
});

describe("a draft's name and an off dataset", () => {
  it("files a copy under its own name, not one from a dataset that is off", () =>
    drafted(async (tx, sample) => {
      const copy = await addMeasure(
        tx,
        sample,
        { dataset: "Retail", measure: "Orders" },
        { name: "Turnover", expression: "SUM(Sales[Net amount])" },
      );
      await setRole(tx, "worker_rw");
      await tx
        .update(powerbiDataset)
        .set({ enabled: false })
        .where(eq(powerbiDataset.id, datasetId(sample, "Sales")));
      await draft(tx, [datasetId(sample, "Retail")]);

      expect((await metricHolding(tx, copy)).name).toBe("turnover");
      expect(await namesSeenBy(tx, readerOf(sample, "Retail"))).not.toContain(
        "net_sales",
      );
    }));
});

describe("a draft's name and PII", () => {
  it("never names a draft a reader sees from a PII measure of their own dataset", () =>
    drafted(async (tx, sample) => {
      await markPii(tx, "Sales", "Net sales");
      const copy = await addMeasure(
        tx,
        sample,
        { dataset: "Sales", measure: "Net sales" },
        { name: "Turnover", expression: "SUM(Sales[Net amount])" },
      );
      await draft(tx, [datasetId(sample, "Sales")]);

      const reader = readerOf(sample, "Sales");
      expect((await metricHolding(tx, copy)).name).toBe("turnover");
      const names = await namesSeenBy(tx, reader);
      expect(names).toContain("turnover");
      expect(names).not.toContain("net_sales");
    }));

  it("files no variant a reader sees under its PII base, even after the rule came later", () =>
    drafted(async (tx, sample) => {
      const reader = readerOf(sample, "Sales");
      const shifted = sample.measureId({
        dataset: "Sales",
        measure: "Units sold LY",
      });
      expect((await metricHolding(tx, shifted)).name).toBe("units_sold");
      expect(await namesSeenBy(tx, reader)).toContain("units_sold");

      await markPii(tx, "Sales", "Units sold");
      await draft(tx, [datasetId(sample, "Sales")]);

      expect((await metricHolding(tx, shifted)).name).toBe("units_sold_ly");
      const names = await namesSeenBy(tx, reader);
      expect(names).toContain("units_sold_ly");
      expect(names).not.toContain("units_sold");
    }));

  it("files a PII variant under its base as before", () =>
    drafted(async (tx, sample) => {
      await markPii(tx, "Sales", "Units sold");
      await markPii(tx, "Sales", "Units sold LY");
      await draft(tx, [datasetId(sample, "Sales")]);
      expect(
        (
          await metricHolding(
            tx,
            sample.measureId({ dataset: "Sales", measure: "Units sold LY" }),
          )
        ).name,
      ).toBe("units_sold");
    }));

  it.each([
    ["skip", { skip: { name_patterns: ["^Mmm named$"] } }],
    ["dismiss", { dismiss: [{ name_pattern: "^Mmm named$", reason: "No." }] }],
  ])(
    "files a shift whose base a %s rule keeps out under a copy that is not PII, though a PII one sorts first",
    (_rule, drafting) =>
      drafted(async (tx, sample) => {
        const beside = { dataset: "Sales", measure: "Net sales" };
        const expression = "SUM(Sales[Quantity]) * 11";
        for (const name of ["Mmm named", "Aaa private", "Zzz open"])
          await addMeasure(tx, sample, beside, { name, expression });
        const shift = await addMeasure(tx, sample, beside, {
          name: "Mmm named LY",
          expression:
            "CALCULATE([Mmm named], SAMEPERIODLASTYEAR('Date'[Date]))",
        });
        await markPii(tx, "Sales", "Aaa private");
        await setConventions({ db: tx }, principals.admin, {
          preset: "metrics_book",
          drafting,
        });
        await draft(tx, [datasetId(sample, "Sales")]);

        expect((await metricHolding(tx, shift)).name).toBe("zzz_open");
        const names = await namesSeenBy(tx, readerOf(sample, "Sales"));
        expect(names).toContain("zzz_open");
        expect(names).not.toContain("aaa_private");
      }),
  );
});

describe("a curator's name stands, and reaches only a copy of its name", () => {
  const curatorOf = (sample: SampleMirror, ...names: string[]) =>
    reaching(
      { powerbi_dataset_ids: names.map((name) => datasetId(sample, name)) },
      "curator",
    );
  const COPY = { name: "Net Sales", expression: "SUM(Sales[Net amount])" };

  it("moves nothing of another name when a curator confirms a key they alone can see", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curatorOf(sample, "Sales"), { db: tx });
      await renameMetric(context, "net_sales", "net_sales");
      await draft(tx, allOf(sample));

      const revenue = sample.measureId(REVENUE);
      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
      const names = await namesSeenBy(tx, readerOf(sample, "Finance"));
      expect(names).not.toContain("net_sales");
      expect(names).not.toContain("Net sales");
    }));

  it("gathers a copy of its name under a name a person confirmed, and no other name", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curatorOf(sample, "Sales", "Marketing"), {
        db: tx,
      });
      await renameMetric(context, "net_sales", "total_net_sales");
      const copy = await addMeasure(tx, sample, RETAIL_ORDERS, COPY);
      await draft(tx, allOf(sample));

      expect((await metricHolding(tx, copy)).name).toBe("total_net_sales");
      const revenue = sample.measureId(REVENUE);
      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
    }));

  it("keeps a touched draft's key and filings, and gathers only that key's copies", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curatorOf(sample, "Sales", "Marketing"), {
        db: tx,
      });
      await updateMetric(context, "net_sales", { definition: "Net of VAT." });
      const net = sample.measureId({ dataset: "Sales", measure: "Net sales" });
      const before = await metricHolding(tx, net);
      const copy = await addMeasure(tx, sample, RETAIL_ORDERS, COPY);
      await draft(tx, allOf(sample));

      const after = await metricHolding(tx, net);
      expect(after.id).toBe(before.id);
      expect(after.name).toBe("net_sales");
      expect(after.name_is_generated).toBe(true);
      expect((await metricHolding(tx, copy)).id).toBe(before.id);
      const revenue = sample.measureId(REVENUE);
      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
    }));

  it("gathers nothing under a label a curator wrote while the key is still generated", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(curatorOf(sample, "Sales"), { db: tx });
      await updateMetric(context, "units_sold", { label: "Volume" });
      const units = sample.measureId({
        dataset: "Sales",
        measure: "Units sold",
      });
      await setRole(tx, "worker_rw");
      const [measure] = await tx
        .select()
        .from(powerbiMeasure)
        .where(eq(powerbiMeasure.id, units));
      const copy = await addMeasure(tx, sample, REVENUE, {
        name: "Volume",
        expression: measure?.expression ?? "",
      });
      await draft(tx, [datasetId(sample, "Finance")]);

      expect((await metricHolding(tx, copy)).name).toBe("volume");
      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        "units_sold",
      );
    }));

  /** Sales' Net sales is the only live measure of a metric a person worked on. */
  async function onlyThroughSales(
    tx: Db,
    sample: SampleMirror,
    confirmed: boolean,
  ) {
    const curated = await metricHolding(
      tx,
      sample.measureId({ dataset: "Sales", measure: "Net sales" }),
    );
    await setRole(tx, "worker_rw");
    await tx
      .update(powerbiMeasure)
      .set({ removed_at: new Date() })
      .where(
        eq(
          powerbiMeasure.id,
          sample.measureId({ dataset: "Marketing", measure: "Net Sales" }),
        ),
      );
    await tx
      .update(metric)
      .set({
        touched_at: new Date(),
        definition: "Words about Sales.",
        ...(confirmed && {
          name: "words_about_sales",
          name_is_generated: false,
        }),
      })
      .where(eq(metric.id, curated.id));
    return curated.id;
  }

  it.each([
    ["a confirmed name", "on", true, true],
    ["a confirmed name", "off", true, false],
    ["a confirmed name", "PII", true, false],
    ["a touched draft", "on", false, true],
    ["a touched draft", "off", false, false],
    ["a touched draft", "PII", false, false],
  ])(
    "shows %s to a copy's reader only through a measure readers may see: Net sales %s",
    (_what, state, confirmed, gathers) =>
      drafted(async (tx, sample) => {
        const curated = await onlyThroughSales(tx, sample, confirmed);
        if (state === "off")
          await tx
            .update(powerbiDataset)
            .set({ enabled: false })
            .where(eq(powerbiDataset.id, datasetId(sample, "Sales")));
        if (state === "PII") {
          await setRole(tx, "api_rw");
          await markPii(tx, "Sales", "Net sales");
        }
        const copy = await addMeasure(tx, sample, RETAIL_ORDERS, COPY);
        await draft(tx, [datasetId(sample, "Retail")]);

        const holder = await metricHolding(tx, copy);
        expect(holder.id === curated).toBe(gathers);
        const { items } = await seenBy(tx, readerOf(sample, "Retail"));
        expect(items.some((item) => item.id === curated)).toBe(gathers);
      }),
  );
});

describe("a measure gone from Power BI", () => {
  const gone = (tx: Db, id: string) =>
    tx
      .update(powerbiMeasure)
      .set({ removed_at: new Date() })
      .where(eq(powerbiMeasure.id, id));

  it("leaves a draft the sync made, so its dataset's reader loses the name", () =>
    drafted(async (tx, sample) => {
      const revenue = sample.measureId(REVENUE);
      const named = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Net sales" }),
      );
      await setRole(tx, "worker_rw");
      await tx
        .update(metricVariant)
        .set({ metric_id: named.id })
        .where(eq(metricVariant.measure_id, revenue));
      await gone(tx, revenue);
      await draft(tx, allOf(sample));

      expect(
        await tx
          .select()
          .from(metricVariant)
          .where(eq(metricVariant.measure_id, revenue)),
      ).toEqual([]);
      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        "net_sales",
      );
    }));

  it("takes no PII name through a removed shift", () =>
    drafted(async (tx, sample) => {
      await setRole(tx, "worker_rw");
      await gone(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Units sold LY" }),
      );
      await setRole(tx, "api_rw");
      await markPii(tx, "Sales", "Units sold");
      await draft(tx, [datasetId(sample, "Sales")]);

      expect(await namesSeenBy(tx, readerOf(sample, "Sales"))).not.toContain(
        "units_sold",
      );
    }));

  it("stays where its dataset holds a measure of the draft's name, to come back", () =>
    drafted(async (tx, sample) => {
      const shift = sample.measureId({
        dataset: "Sales",
        measure: "Units sold LY",
      });
      const [before] = await tx
        .select()
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, shift));
      await setRole(tx, "worker_rw");
      await gone(tx, shift);
      await draft(tx, allOf(sample));

      const [after] = await tx
        .select()
        .from(metricVariant)
        .where(eq(metricVariant.measure_id, shift));
      expect(after?.id).toBe(before?.id);
    }));

  it("leaves the draft too when its dataset was removed by an older sync", () =>
    drafted(async (tx, sample) => {
      const finance = datasetId(sample, "Finance");
      const dataset = sample.tenant.datasets.find((d) => d.id === finance);
      if (dataset === undefined) throw new Error("No Finance");
      const named = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Net sales" }),
      );
      await setRole(tx, "worker_rw");
      await tx
        .update(metricVariant)
        .set({ metric_id: named.id })
        .where(eq(metricVariant.measure_id, sample.measureId(REVENUE)));
      await removeDatasets(tx, [finance], new Date());

      const ids = await removedDatasetsInDrafts(tx);
      expect(ids).toEqual([finance]);
      await draft(tx, ids);

      const member = reaching({
        powerbi_workspace_ids: [dataset.workspace_id],
      });
      expect(await namesSeenBy(tx, member)).not.toContain("net_sales");
      await setRole(tx, "worker_rw");
      expect(await removedDatasetsInDrafts(tx)).toEqual([]);
    }));

  it("stays in a draft a curator touched, and in a dismissed draft", () =>
    drafted(async (tx, sample) => {
      const orders = sample.measureId({ dataset: "Sales", measure: "Orders" });
      const shift = sample.measureId({
        dataset: "Sales",
        measure: "Units sold LY",
      });
      await setRole(tx, "worker_rw");
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(eq(metric.id, (await metricHolding(tx, orders)).id));
      await tx
        .update(metric)
        .set({ dismissed_at: new Date(), dismissed_reason: "A copy" })
        .where(eq(metric.id, (await metricHolding(tx, shift)).id));
      await gone(tx, orders);
      await gone(tx, shift);
      await draft(tx, allOf(sample));

      expect((await metricHolding(tx, orders)).name).toBe("orders");
      expect((await metricHolding(tx, shift)).name).toBe("units_sold");
    }));
});

describe("a dismissal rule on an older draft", () => {
  it("takes no name from the draft it found the measure in", () =>
    drafted(async (tx, sample) => {
      const adSpend = sample.measureId({
        dataset: "Marketing",
        measure: "Ad spend",
      });
      const held = await metricHolding(tx, adSpend);
      await setRole(tx, "worker_rw");
      await tx
        .update(metric)
        .set({ name: "old_sales", label: "Old sales" })
        .where(eq(metric.id, held.id));
      await setRole(tx, "api_rw");
      await setConventions({ db: tx }, principals.admin, {
        preset: "metrics_book",
        drafting: {
          dismiss: [{ name_pattern: "^Ad spend$", reason: "Not a metric." }],
        },
      });
      await draft(tx, [datasetId(sample, "Marketing")]);

      const after = await metricHolding(tx, adSpend);
      expect(after.name).toBe("ad_spend");
      expect(after.dismissed_reason).toBe("Not a metric.");
      expect(
        await namesSeenBy(tx, readerOf(sample, "Marketing")),
      ).not.toContain("old_sales");
    }));
});

describe("a draft a curator empties", () => {
  const AD_SPEND = { dataset: "Marketing", measure: "Ad spend" };
  const MARKETING_ORDERS = { dataset: "Marketing", measure: "Orders" };
  const inMarketing = (tx: Db, sample: SampleMirror) =>
    asPerson(
      reaching(
        { powerbi_dataset_ids: [datasetId(sample, "Marketing")] },
        "curator",
      ),
      { db: tx },
    );
  const variantOf = async (tx: Db, measureId: string) => {
    const [row] = await tx
      .select()
      .from(metricVariant)
      .where(eq(metricVariant.measure_id, measureId));
    if (row === undefined) throw new Error(`No variant of ${measureId}`);
    return row;
  };
  const rowOf = (tx: Db, id: string) =>
    tx.select().from(metric).where(eq(metric.id, id));

  it("is gone in the same change when a move takes its last measure", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      const measure = sample.measureId(AD_SPEND);
      const { metric_id, id } = await variantOf(tx, measure);
      await moveVariant(context, id, { to_metric: "words" });

      expect(await rowOf(tx, metric_id)).toEqual([]);
      expect(await namesSeenBy(tx, readerOf(sample, "Sales"))).not.toContain(
        "ad_spend",
      );
      await setRole(tx, "worker_rw");
      const changes = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_id, metric_id));
      expect(changes.map(({ action }) => action)).toContain("delete");
    }));

  it("is gone in the same change when a merge takes it", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      const { metric_id } = await variantOf(tx, sample.measureId(AD_SPEND));
      await mergeMetrics(context, { from: "ad_spend", into: "words" });

      expect(await rowOf(tx, metric_id)).toEqual([]);
      expect(await namesSeenBy(tx, readerOf(sample, "Sales"))).not.toContain(
        "ad_spend",
      );
    }));

  it("stays while it holds a live measure, and only that dataset's reader reads it", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      const held = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Orders" }),
      );
      const marketing = sample.measureId({
        dataset: "Marketing",
        measure: "Orders",
      });
      const { id, metric_id } = await variantOf(tx, marketing);
      expect(metric_id).toBe(held.id);
      await moveVariant(context, id, { to_metric: "words" });

      expect(await rowOf(tx, held.id)).toHaveLength(1);
      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        held.name,
      );
    }));

  it("is gone when all it has left are measures gone from Power BI", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      const base = await variantOf(tx, sample.measureId(MARKETING_ORDERS));
      await setRole(tx, "worker_rw");
      await tx
        .update(powerbiMeasure)
        .set({ removed_at: new Date() })
        .where(eq(powerbiMeasure.dataset_id, datasetId(sample, "Sales")));
      await setRole(tx, "api_rw");
      await moveVariant(context, base.id, { to_metric: "words" });

      expect(await rowOf(tx, base.metric_id)).toEqual([]);
    }));

  it("is gone when a rule dismissed it", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      const { id, metric_id } = await variantOf(tx, sample.measureId(AD_SPEND));
      await setRole(tx, "worker_rw");
      await tx
        .update(metric)
        .set({ dismissed_at: new Date(), dismissed_reason: "A rule." })
        .where(eq(metric.id, metric_id));
      await setRole(tx, "api_rw");
      await moveVariant(context, id, { to_metric: "words" });

      expect(await rowOf(tx, metric_id)).toEqual([]);
    }));

  it("stays while its only live measure left is PII, and shows no one who may not see it", () =>
    drafted(async (tx, sample) => {
      const inSales = asPerson(
        reaching(
          { powerbi_dataset_ids: [datasetId(sample, "Sales")] },
          "curator",
        ),
        { db: tx },
      );
      await createMetric(inSales, { name: "words", label: "Words" });
      const base = sample.measureId({
        dataset: "Sales",
        measure: "Units sold",
      });
      const { metric_id } = await variantOf(tx, base);
      await setRole(tx, "worker_rw");
      const shifts = await tx
        .select()
        .from(metricVariant)
        .where(eq(metricVariant.metric_id, metric_id));
      await setRole(tx, "api_rw");
      await markPii(tx, "Sales", "Units sold");
      for (const variant of shifts.filter((v) => v.measure_id !== base))
        await moveVariant(inSales, variant.id, { to_metric: "words" });

      expect(await rowOf(tx, metric_id)).toHaveLength(1);
      expect(await namesSeenBy(tx, readerOf(sample, "Sales"))).not.toContain(
        "units_sold",
      );
    }));

  it("stays when a person worked on it", () =>
    drafted(async (tx, sample) => {
      const context = inMarketing(tx, sample);
      await createMetric(context, { name: "words", label: "Words" });
      await updateMetric(context, "ad_spend", { definition: "What we spend." });
      const { id, metric_id } = await variantOf(tx, sample.measureId(AD_SPEND));
      await moveVariant(context, id, { to_metric: "words" });

      expect(await rowOf(tx, metric_id)).toHaveLength(1);
    }));
});

describe("a dataset turned on", () => {
  /** Turns it on as an admin, then runs the request that left in the queue. */
  async function turnOn(tx: Db, dataset: string) {
    await setEnabled(
      asPerson(reaching({}, "admin"), { db: tx }),
      dataset,
      true,
    );
    await setRole(tx, "worker_rw");
    const [asked] = await tx
      .select()
      .from(jobRequest)
      .where(
        and(
          eq(jobRequest.job, "sync"),
          sql`${jobRequest.args}->>'draft_dataset' = ${dataset}`,
        ),
      );
    if (asked === undefined) throw new Error("Nothing was queued");
    const job = handlerFor("sync", "worker");
    if (job === undefined) throw new Error("No sync job");
    await job.handler(
      createTestDeps({ container: "worker", db: tx }),
      asked.args,
      asked.trigger,
    );
    await setRole(tx, "api_rw");
  }
  const turnOff = (tx: Db, dataset: string) =>
    tx
      .update(powerbiDataset)
      .set({ enabled: false })
      .where(eq(powerbiDataset.id, dataset));

  it("takes another dataset's name off its reader's list", () =>
    drafted(async (tx, sample) => {
      const finance = datasetId(sample, "Finance");
      const named = await metricHolding(
        tx,
        sample.measureId({ dataset: "Sales", measure: "Net sales" }),
      );
      // As a book older than the rule left it, with Finance off and so not drafted.
      await setRole(tx, "worker_rw");
      await tx
        .update(metricVariant)
        .set({ metric_id: named.id })
        .where(eq(metricVariant.measure_id, sample.measureId(REVENUE)));
      await turnOff(tx, finance);
      await setRole(tx, "api_rw");

      await turnOn(tx, finance);

      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        "net_sales",
      );
    }));

  it("takes a name a PII rule covered while it was off off its reader's list", () =>
    drafted(async (tx, sample) => {
      const sales = datasetId(sample, "Sales");
      await setRole(tx, "worker_rw");
      await turnOff(tx, sales);
      await setRole(tx, "api_rw");
      await markPii(tx, "Sales", "Units sold");

      await turnOn(tx, sales);

      expect(await namesSeenBy(tx, readerOf(sample, "Sales"))).not.toContain(
        "units_sold",
      );
    }));
});

describe("a number in a measure's own name", () => {
  it("is no suffix that lets another name in", () =>
    drafted(async (tx, sample) => {
      const expression = "SUM(Sales[Quantity]) * 7";
      const net = { dataset: "Sales", measure: "Net sales" };
      await addMeasure(tx, sample, net, { name: "Zeta", expression });
      await addMeasure(tx, sample, net, { name: "Zeta 2", expression });
      const held = await addMeasure(tx, sample, net, {
        name: "Zeta-2",
        expression,
      });
      const copy = await addMeasure(tx, sample, REVENUE, {
        name: "Zeta",
        expression,
      });
      await draft(tx, [datasetId(sample, "Sales")]);
      expect((await metricHolding(tx, held)).name).toBe("zeta_2");
      await draft(tx, [datasetId(sample, "Finance")]);

      expect((await metricHolding(tx, copy)).name).toBe("zeta");
      const names = await namesSeenBy(tx, readerOf(sample, "Finance"));
      expect(names).not.toContain("zeta_2");
      expect(names).not.toContain("Zeta 2");
    }));
});

describe("a group that grows after a metric proved it", () => {
  it("files a measure that is not PII by the group's name, not a PII one remembered", () =>
    drafted(async (tx, sample) => {
      const shifted = `CALCULATE(CALCULATE(SUM(Sales[Quantity])), SAMEPERIODLASTYEAR('Date'[Date]))`;
      await addMeasure(
        tx,
        sample,
        { dataset: "Sales", measure: "Net sales" },
        { name: "Bravo", expression: shifted },
      );
      await addMeasure(tx, sample, REVENUE, {
        name: "Bravo",
        expression: shifted,
      });
      await addMeasure(tx, sample, REVENUE, {
        name: "Bravo LY",
        expression: `CALCULATE([Bravo], SAMEPERIODLASTYEAR('Date'[Date]))`,
      });
      await addMeasure(tx, sample, REVENUE, {
        name: "Zulu",
        expression: "SUM(Sales[Quantity])",
      });
      const zuluLy = await addMeasure(tx, sample, REVENUE, {
        name: "Zulu LY",
        expression: `CALCULATE([Zulu], SAMEPERIODLASTYEAR('Date'[Date]))`,
      });
      for (const name of ["Bravo", "Bravo LY", "Zulu"])
        await markPii(tx, "Sales", name);
      await draft(tx, [datasetId(sample, "Sales")]);
      await draft(tx, [datasetId(sample, "Finance")]);

      expect((await metricHolding(tx, zuluLy)).name).toBe("zulu_ly");
      expect(await namesSeenBy(tx, readerOf(sample, "Finance"))).not.toContain(
        "bravo",
      );
    }));
});

describe("suggestSameNames and a crafted model", () => {
  it("answers for one draft of 16,000 measures of one calculation within a test's time", () =>
    drafted(async (tx, sample) => {
      const [near] = await tx
        .select()
        .from(powerbiMeasure)
        .where(
          eq(
            powerbiMeasure.id,
            sample.measureId({ dataset: "Sales", measure: "Net sales" }),
          ),
        );
      if (near === undefined) throw new Error("No Net sales");
      await setRole(tx, "worker_rw");
      const [crafted] = await tx
        .insert(metric)
        .values({
          name: "crafted",
          label: "Crafted",
          origin: "sync",
          name_is_generated: true,
        })
        .returning();
      if (crafted === undefined) throw new Error("The metric was not made");
      for (let at = 0; at < 16_000; at += 2_000) {
        const rows = await tx
          .insert(powerbiMeasure)
          .values(
            Array.from({ length: 2_000 }, (_, offset) => ({
              dataset_id: near.dataset_id,
              table_id: near.table_id,
              name: `Crafted ${String(at + offset)}`,
              expression: "1",
              fingerprint: "crafted",
            })),
          )
          .returning({ id: powerbiMeasure.id });
        await tx.insert(metricVariant).values(
          rows.map((row) => ({
            metric_id: crafted.id,
            measure_id: row.id,
            assigned_by: "sync" as const,
          })),
        );
      }
      const started = performance.now();
      expect(await suggestSameNames(tx, [crafted.id], undefined)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(15_000);
    }));
});

describe("a draft's key and a curated alias", () => {
  const curator = reaching({}, "curator");

  /** A curated metric holding the alias, with no variant, so every reader sees it. */
  async function holdingAlias(tx: Db, alias: string): Promise<string> {
    const [row] = await tx
      .insert(metric)
      .values({
        name: "curated_turnover",
        label: "Curated turnover",
        origin: "curator",
        aliases: [alias],
        touched_at: new Date(),
      })
      .returning();
    if (row === undefined) throw new Error("The metric was not made");
    return row.id;
  }

  it("takes no key that a curated alias holds, and the alias keeps finding its metric", () =>
    inSampleMirror("api_rw", async (tx, sample) => {
      const curated = await holdingAlias(tx, "REVENUE");
      await draft(tx, allOf(sample));

      const revenue = await metricHolding(
        tx,
        sample.measureId({ dataset: "Finance", measure: "Revenue" }),
      );
      expect(revenue.name).toBe("revenue_2");
      expect(revenue.label).toBe("Revenue");
      const context = asPerson(curator, { db: tx });
      expect((await getMetric(context, "revenue")).id).toBe(curated);
      expect((await getMetric(context, "REVENUE")).id).toBe(curated);
    }));

  it("takes no free key back while an alias holds it", () =>
    inSampleMirror("api_rw", async (tx, sample) => {
      await holdingAlias(tx, "revenue");
      await draft(tx, allOf(sample));
      await draft(tx, allOf(sample));
      expect(
        (
          await metricHolding(
            tx,
            sample.measureId({ dataset: "Finance", measure: "Revenue" }),
          )
        ).name,
      ).toBe("revenue_2");
    }));

  it("gives up a generated key at the next sync when an alias already holds it", () =>
    drafted(async (tx, sample) => {
      const revenue = sample.measureId(REVENUE);
      expect((await metricHolding(tx, revenue)).name).toBe("revenue");
      const curated = await holdingAlias(tx, "Revenue");
      await draft(tx, allOf(sample));

      expect((await metricHolding(tx, revenue)).name).toBe("revenue_2");
      const context = asPerson(curator, { db: tx });
      expect((await getMetric(context, "revenue")).id).toBe(curated);
    }));

  it("refuses an alias a key holds, the same for a metric the curator cannot see", () =>
    drafted(async (tx, sample) => {
      const elsewhere = asPerson(
        reaching(
          { powerbi_dataset_ids: [datasetId(sample, "Finance")] },
          "curator",
        ),
        { db: tx },
      );
      await expect(getMetric(elsewhere, "net_sales")).rejects.toMatchObject({
        kind: "not_found",
      });
      for (const alias of ["net_sales", "NET_SALES"]) {
        await expect(
          updateMetric(elsewhere, "revenue", { aliases: [alias] }),
        ).rejects.toMatchObject({ kind: "conflict" });
      }
      await expect(
        createMetric(elsewhere, {
          name: "words",
          label: "Words",
          aliases: ["net_sales"],
        }),
      ).rejects.toMatchObject({ kind: "conflict" });
      // Postgres folds this to `gross_margin`, as a reference does, and JavaScript does not.
      const marketing = asPerson(
        reaching(
          { powerbi_dataset_ids: [datasetId(sample, "Marketing")] },
          "curator",
        ),
        { db: tx },
      );
      await expect(getMetric(marketing, "gross_margin")).rejects.toMatchObject({
        kind: "not_found",
      });
      await expect(
        updateMetric(marketing, "ad_spend", { aliases: ["GROSS_MARGİN"] }),
      ).rejects.toMatchObject({ kind: "conflict" });
      await draft(tx, allOf(sample));
      const net = sample.measureId({ dataset: "Sales", measure: "Net sales" });
      expect((await metricHolding(tx, net)).name).toBe("net_sales");

      // Its own key, and a word no key holds, are fine.
      const set = await updateMetric(elsewhere, "revenue", {
        aliases: ["revenue", "Net sales"],
      });
      expect(set.aliases).toEqual(["revenue", "Net sales"]);
    }));

  it("refuses a key another metric holds as an alias, the same for one the curator cannot see", () =>
    drafted(async (tx, sample) => {
      const inDataset = (name: string) =>
        asPerson(
          reaching(
            { powerbi_dataset_ids: [datasetId(sample, name)] },
            "curator",
          ),
          { db: tx },
        );
      const marketing = inDataset("Marketing");
      await updateMetric(marketing, "ad_spend", { aliases: ["PROMO_COST"] });
      const sales = inDataset("Sales");
      await expect(getMetric(sales, "ad_spend")).rejects.toMatchObject({
        kind: "not_found",
      });

      await expect(
        renameMetric(sales, "units_sold", "promo_cost"),
      ).rejects.toMatchObject({ kind: "conflict" });
      await expect(
        createMetric(sales, { name: "promo_cost", label: "Promo cost" }),
      ).rejects.toMatchObject({ kind: "conflict" });
      expect((await getMetric(marketing, "promo_cost")).name).toBe("ad_spend");

      // A metric may take its own alias as its key.
      const own = await renameMetric(marketing, "ad_spend", "promo_cost");
      expect(own.name).toBe("promo_cost");
    }));

  it("lets a sync finish with more aliases than one statement can bind", () =>
    inSampleMirror("api_rw", async (tx, sample) => {
      const many = Array.from(
        { length: 70_000 },
        (_, at) => `word ${String(at)}`,
      );
      await holdingAlias(tx, "revenue");
      await tx
        .update(metric)
        .set({ aliases: [...many, "revenue"] })
        .where(eq(metric.name, "curated_turnover"));
      await setRole(tx, "worker_rw");
      const counts = await draftDatasets(
        createTestDeps({ container: "worker", db: tx }),
        allOf(sample),
      );
      expect(counts.failed).toBe(0);
      expect((await metricHolding(tx, sample.measureId(REVENUE))).name).toBe(
        "revenue_2",
      );
    }));

  it("leaves a touched draft its name when an alias asks for it", () =>
    drafted(async (tx, sample) => {
      const context = asPerson(
        reaching(
          { powerbi_dataset_ids: [datasetId(sample, "Finance")] },
          "curator",
        ),
        { db: tx },
      );
      await updateMetric(context, "revenue", { definition: "Net of VAT." });
      await holdingAlias(tx, "revenue");
      await draft(tx, allOf(sample));
      expect(
        (
          await metricHolding(
            tx,
            sample.measureId({ dataset: "Finance", measure: "Revenue" }),
          )
        ).name,
      ).toBe("revenue");
    }));
});
