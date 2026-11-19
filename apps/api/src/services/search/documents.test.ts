import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../context.js";
import {
  category,
  metric,
  metricVariant,
  term,
  termColumn,
} from "../../db/schema/book.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { searchDocument } from "../../db/schema/search.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { asPerson } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import { setEnabled } from "../admin/datasets.js";
import { removeRule, setRule } from "../pii/rules.js";
import { buildDocuments, SEARCH_TEXT_MAX_BYTES } from "./documents.js";

afterAll(closeTestPools);

const SALES = "Sales";
const FINANCE = "Finance";

/** A small book on the sample mirror: two categories, a metric with two variants in two datasets, a term on a column, and a dismissed metric. */
async function seedBook(tx: Db, sample: SampleMirror) {
  await setRole(tx, "api_rw");
  const [root] = await tx
    .insert(category)
    .values({ name: "Sales", key: "sales" })
    .returning();
  const [orders] = await tx
    .insert(category)
    .values({
      name: "Orders",
      key: "orders",
      parent_id: root?.id,
      description: "Everything about orders.",
    })
    .returning();
  const [kept] = await tx
    .insert(metric)
    .values({
      name: "number_of_orders",
      label: "Number of orders",
      definition: "How many orders were placed.",
      aliases: ["order count", "orders placed"],
      when_to_use: "Counting orders, not their value.",
      grain_and_filters: "One row per order, returns included.",
      category_id: orders?.id,
      origin: "curator",
      trust_state: "agent_verified",
      custom: { team: "sample sales" },
    })
    .returning();
  const [dismissed] = await tx
    .insert(metric)
    .values({
      name: "sample_helper",
      label: "Sample helper",
      origin: "sync",
      dismissed_at: new Date(),
    })
    .returning();
  const [region] = await tx
    .insert(term)
    .values({
      name: "Customer region",
      aliases: ["area"],
      definition: "Where the customer lives.",
      values: ["North", "South"],
      custom: { kind: "dimension" },
    })
    .returning();
  const column = sample.columnId({
    dataset: SALES,
    table: "Customer",
    column: "Region",
  });
  await tx
    .insert(termColumn)
    .values({ term_id: region?.id ?? "", column_id: column });
  await setRole(tx, "worker_rw");

  const base = sample.measureId({ dataset: SALES, measure: "Orders" });
  const shifted = sample.measureId({
    dataset: FINANCE,
    measure: "Order count",
  });
  await tx
    .update(powerbiMeasure)
    .set({
      description: "Our words about orders.",
      description_pbi: "Power BI's words about orders.",
      custom: { reviewed: true },
    })
    .where(eq(powerbiMeasure.id, base));
  const variants = await tx
    .insert(metricVariant)
    .values([
      { metric_id: kept?.id ?? "", measure_id: base, assigned_by: "curator" },
      {
        metric_id: kept?.id ?? "",
        measure_id: shifted,
        period: "previous_year",
        comparison: "growth_rate",
        comparison_period: "previous_month",
        currency: "EUR",
        shift_note: "Sample note.",
        assigned_by: "curator",
      },
    ])
    .returning();
  const [baseVariant, shiftedVariant] = variants;
  return {
    metric: kept?.id ?? "",
    dismissed: dismissed?.id ?? "",
    term: region?.id ?? "",
    category: orders?.id ?? "",
    column,
    base,
    shifted,
    baseVariant: baseVariant?.id ?? "",
    shiftedVariant: shiftedVariant?.id ?? "",
  };
}

async function document(tx: Db, id: string) {
  const [row] = await tx
    .select()
    .from(searchDocument)
    .where(eq(searchDocument.id, id));
  if (row === undefined) throw new Error(`no search document ${id}`);
  return row;
}

const countOf = async (tx: Db, kind: string) =>
  (
    await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from search_document where kind = ${kind}`,
    )
  ).rows[0]?.n;

describe("buildDocuments", () => {
  it("makes one document for each metric, variant, column and term, with the spec's text", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await buildDocuments(tx);

      const metricDoc = await document(tx, `metric:${ids.metric}`);
      expect(metricDoc).toMatchObject({
        kind: "metric",
        name: "number_of_orders",
        label: "Number of orders",
        trust_state: "agent_verified",
        category_id: ids.category,
        embedding: null,
      });
      for (const part of [
        "Number of orders",
        "number_of_orders",
        "How many orders were placed.",
        "order count, orders placed",
        "Counting orders, not their value.",
        "One row per order, returns included.",
        "Sales / Orders",
      ])
        expect(metricDoc.search_text).toContain(part);
      // The names of its variants are in their own documents, under their own datasets.
      expect(metricDoc.search_text).not.toContain("Variants");
      expect(metricDoc.search_text).not.toContain("Order count");

      const variantDoc = await document(tx, `variant:${ids.baseVariant}`);
      expect(variantDoc).toMatchObject({
        kind: "variant",
        name: "Orders",
        label: "Number of orders",
        summary: "current period",
      });
      for (const part of [
        "Dataset: Sales (workspace Sales)",
        "Table: Sales",
        "Our words about orders.",
        "Power BI's words about orders.",
        "Metric: Number of orders",
      ])
        expect(variantDoc.search_text).toContain(part);
      expect(
        (await document(tx, `variant:${ids.shiftedVariant}`)).summary,
      ).toBe(
        "previous year, growth rate against previous month, in EUR, Sample note.",
      );

      const columnDoc = await document(tx, `column:${ids.column}`);
      expect(columnDoc.name).toBe("Customer[Region]");
      expect(columnDoc.search_text).toContain("Dataset: Sales");
      expect(columnDoc.search_text).toContain("Term: Customer region");

      const termDoc = await document(tx, `term:${ids.term}`);
      expect(termDoc.search_text).toBe(
        "Customer region\nAlso called: area\nWhere the customer lives.\nValues: North, South",
      );
    });
  });

  it("gives datasets, tables and categories words only, and every kind its datasets, workspaces and apps", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await buildDocuments(tx);
      const { datasets, apps, workspaces } = sample.tenant;
      const sales = datasets.find((d) => d.name === SALES);
      const finance = datasets.find((d) => d.name === FINANCE);
      const salesApp = apps.find((a) => a.name === "Sales app");
      const leadership = apps.find((a) => a.name === "Leadership app");
      expect(workspaces.length).toBeGreaterThan(0);

      const salesDoc = await document(tx, `dataset:${sales?.id ?? ""}`);
      expect(salesDoc).toMatchObject({
        embedding: null,
        dataset_ids: [sales?.id],
        workspace_ids: [sales?.workspace_id],
        app_ids: [salesApp?.id],
      });
      expect(
        (await document(tx, `metric:${ids.metric}`)).dataset_ids.sort(),
      ).toEqual([sales?.id, finance?.id].sort());
      expect(
        (await document(tx, `metric:${ids.metric}`)).app_ids.sort(),
      ).toEqual([salesApp?.id, leadership?.id].sort());
      expect(await document(tx, `category:${ids.category}`)).toMatchObject({
        dataset_ids: [],
        app_ids: [],
        embedding: null,
        summary: "Everything about orders.",
      });

      const tablesInMirror = datasets.reduce((n, d) => n + d.tables.length, 0);
      const columnsInMirror = datasets.reduce(
        (n, d) => n + d.tables.reduce((m, t) => m + t.columns.length, 0),
        0,
      );
      expect(await countOf(tx, "dataset")).toBe(datasets.length);
      expect(await countOf(tx, "table")).toBe(tablesInMirror);
      expect(await countOf(tx, "column")).toBe(columnsInMirror);
      expect(await countOf(tx, "category")).toBe(2);
    });
  });

  it("puts each built-in documentation field of a dataset, table and column in its search text", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const sales = sample.tenant.datasets.find((d) => d.name === SALES);
      const [table] = await tx
        .select({ id: powerbiTable.id })
        .from(powerbiTable)
        .where(
          and(
            eq(powerbiTable.dataset_id, sales?.id ?? ""),
            eq(powerbiTable.name, "Customer"),
          ),
        );
      await tx
        .update(powerbiDataset)
        .set({
          when_to_use: "datasetwhen",
          owner: "datasetowner",
          freshness: "datasetfresh",
          caveats: "datasetcaveat",
        })
        .where(eq(powerbiDataset.id, sales?.id ?? ""));
      await tx
        .update(powerbiTable)
        .set({ grain_and_filters: "tablegrain", caveats: "tablecaveat" })
        .where(eq(powerbiTable.id, table?.id ?? ""));
      await tx
        .update(powerbiColumn)
        .set({ unit: "columnunit", blank_means: "columnblank" })
        .where(eq(powerbiColumn.id, ids.column));
      await buildDocuments(tx);
      const text = async (kind: string, id: string) =>
        (await document(tx, `${kind}:${id}`)).search_text;
      const dataset = await text("dataset", sales?.id ?? "");
      for (const word of [
        "datasetwhen",
        "datasetowner",
        "datasetfresh",
        "datasetcaveat",
      ])
        expect(dataset, word).toContain(word);
      const tableText = await text("table", table?.id ?? "");
      for (const word of ["tablegrain", "tablecaveat"])
        expect(tableText, word).toContain(word);
      const column = await text("column", ids.column);
      for (const word of ["columnunit", "columnblank"])
        expect(column, word).toContain(word);
    });
  });

  it("copies each element's custom fields", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await tx
        .update(powerbiColumn)
        .set({ custom: { pii: false } })
        .where(eq(powerbiColumn.id, ids.column));
      await buildDocuments(tx);
      expect((await document(tx, `metric:${ids.metric}`)).custom).toEqual({
        team: "sample sales",
      });
      expect((await document(tx, `term:${ids.term}`)).custom).toEqual({
        kind: "dimension",
      });
      expect((await document(tx, `column:${ids.column}`)).custom).toEqual({
        pii: false,
      });
      expect((await document(tx, `variant:${ids.baseVariant}`)).custom).toEqual(
        {
          reviewed: true,
        },
      );
    });
  });

  it("leaves out removed and dismissed elements, and deletes the documents they had", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await buildDocuments(tx);
      await tx
        .update(metric)
        .set({ dismissed_at: new Date() })
        .where(eq(metric.id, ids.metric));
      await tx
        .update(powerbiColumn)
        .set({ removed_at: new Date() })
        .where(eq(powerbiColumn.id, ids.column));
      const built = await buildDocuments(tx);
      // The metric, its two variants, and the column.
      expect(built.deleted).toBe(4);
      for (const id of [
        `metric:${ids.metric}`,
        `variant:${ids.baseVariant}`,
        `column:${ids.column}`,
        `metric:${ids.dismissed}`,
      ])
        await expect(document(tx, id)).rejects.toThrow("no search document");
      await tx
        .update(powerbiMeasure)
        .set({ removed_at: new Date() })
        .where(eq(powerbiMeasure.id, ids.base));
      expect((await buildDocuments(tx)).deleted).toBe(0);
    });
  });

  it("writes only what changed, and keeps the embedding of the rest", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const first = await buildDocuments(tx);
      expect(first.written).toBe(first.documents);
      const before = await document(tx, `metric:${ids.metric}`);
      expect(await buildDocuments(tx)).toMatchObject({
        written: 0,
        deleted: 0,
      });
      await tx
        .update(metric)
        .set({ definition: "A changed definition." })
        .where(eq(metric.id, ids.metric));
      expect((await buildDocuments(tx)).written).toBe(1);
      const after = await document(tx, `metric:${ids.metric}`);
      expect(after.search_text).toContain("A changed definition.");
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(
        before.updated_at.getTime(),
      );
      const found = await tx.execute<{ id: string }>(
        sql`select id from search_document where search_tsv @@ plainto_tsquery('simple', 'changed')`,
      );
      expect(found.rows).toEqual([{ id: `metric:${ids.metric}` }]);
    });
  });

  it("compares the book's documents and only the given mirror elements", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await buildDocuments(tx);
      const other = sample.columnId({
        dataset: SALES,
        table: "Customer",
        column: "Segment",
      });
      const describe = (column: string, description: string) =>
        tx
          .update(powerbiColumn)
          .set({ description })
          .where(eq(powerbiColumn.id, column));
      await describe(ids.column, "Words about the region.");
      await describe(other, "Words about the segment.");
      await tx
        .update(metric)
        .set({ definition: "Another definition." })
        .where(eq(metric.id, ids.metric));
      // The metric, its two variants, the term and two categories, and the column.
      const built = await buildDocuments(tx, { element_ids: [ids.column] });
      expect(built).toEqual({ documents: 7, written: 2, deleted: 0 });
      expect((await document(tx, `column:${other}`)).search_text).not.toContain(
        "Words about the segment.",
      );
    });
  });

  it("finds a fresh database with the GIN and HNSW indexes, which sql/search.sql adds after the migration", async () => {
    await inSampleMirror("worker_rw", async (tx) => {
      const { rows } = await tx.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where tablename = 'search_document'`,
      );
      const definitions = rows.map((row) => row.indexdef).join("\n");
      expect(definitions).toContain("USING gin (search_tsv)");
      expect(definitions).toContain("USING hnsw (embedding vector_cosine_ops)");
    });
  });

  it("cuts a long text to 8,000 bytes on a character boundary, in any script", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      // Three bytes a character, four (a surrogate pair), and one.
      for (const word of ["売上", String.fromCodePoint(0x1f600), "word "]) {
        await tx
          .update(metric)
          .set({ definition: word.repeat(6000) })
          .where(eq(metric.id, ids.metric));
        await buildDocuments(tx);
        const { search_text } = await document(tx, `metric:${ids.metric}`);
        const bytes = Buffer.byteLength(search_text);
        expect(bytes).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES);
        // Cut as late as a whole character allows.
        expect(bytes).toBeGreaterThan(SEARCH_TEXT_MAX_BYTES - 4);
        expect(search_text.isWellFormed()).toBe(true);
        expect(search_text).not.toContain("\uFFFD");
      }
    });
  });

  it("leaves out a metric whose variants are all gone, and keeps one that never had any", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const [unfiled] = await tx
        .insert(metric)
        .values({
          name: "sample_unfiled",
          label: "Sample unfiled",
          origin: "curator",
        })
        .returning();
      const finance = sample.tenant.datasets.find((d) => d.name === FINANCE);
      await buildDocuments(tx);
      await document(tx, `metric:${ids.metric}`);

      await tx
        .update(powerbiMeasure)
        .set({ removed_at: new Date() })
        .where(eq(powerbiMeasure.id, ids.base));
      await buildDocuments(tx);
      // One variant is live, in Finance, and that is all the metric reaches.
      expect((await document(tx, `metric:${ids.metric}`)).dataset_ids).toEqual([
        finance?.id,
      ]);

      await tx
        .update(powerbiDataset)
        .set({ removed_at: new Date() })
        .where(eq(powerbiDataset.id, finance?.id ?? ""));
      await buildDocuments(tx);
      await expect(document(tx, `metric:${ids.metric}`)).rejects.toThrow(
        "no search document",
      );
      expect(await document(tx, `metric:${unfiled?.id ?? ""}`)).toMatchObject({
        dataset_ids: [],
      });
    });
  });

  it("leaves a personal workspace's name out of the text", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const [workspace, dataset, table, measure] = [1, 2, 3, 4].map(() =>
        randomUUID(),
      );
      await tx.insert(powerbiWorkspace).values({
        id: workspace ?? "",
        name: "Sam Owner's workspace",
        type: "personal_group",
      });
      await tx.insert(powerbiDataset).values({
        id: dataset ?? "",
        workspace_id: workspace ?? "",
        name: "Notes",
      });
      await tx.insert(powerbiTable).values({
        id: table ?? "",
        dataset_id: dataset ?? "",
        name: "Notes",
      });
      await tx.insert(powerbiMeasure).values({
        id: measure ?? "",
        dataset_id: dataset ?? "",
        table_id: table ?? "",
        name: "Note count",
      });
      const [variant] = await tx
        .insert(metricVariant)
        .values({
          metric_id: ids.metric,
          measure_id: measure ?? "",
          assigned_by: "curator",
        })
        .returning();
      await buildDocuments(tx);
      const personal = await document(tx, `variant:${variant?.id ?? ""}`);
      expect(personal.search_text).toContain("Dataset: Notes");
      expect(personal.search_text).not.toContain("Owner");
      expect(
        (await document(tx, `dataset:${dataset ?? ""}`)).search_text,
      ).not.toContain("Owner");
      // A team workspace still names itself.
      expect(
        (await document(tx, `variant:${ids.baseVariant}`)).search_text,
      ).toContain("(workspace Sales)");
    });
  });

  it("deletes a PII column's document and brings it back when the rule is cleared", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      await buildDocuments(tx);
      const admin = asPerson(principals.admin, { db: tx });
      await setRole(tx, "api_rw");
      const { rule } = await setRule(admin, {
        kind: "column",
        table_name: "Customer",
        name: "Region",
        pii: true,
      });
      await setRole(tx, "worker_rw");
      const built = await buildDocuments(tx);
      expect(built.deleted).toBe(1);
      await expect(document(tx, `column:${ids.column}`)).rejects.toThrow(
        "no search document",
      );
      // The term that backs the column still has its own document.
      await document(tx, `term:${ids.term}`);

      await setRole(tx, "api_rw");
      await removeRule(admin, rule.id);
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      await document(tx, `column:${ids.column}`);
    });
  });

  it("leaves out a measure's variant document while a measure rule marks it", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const [held] = await tx
        .select({ table_name: powerbiTable.name, name: powerbiMeasure.name })
        .from(powerbiMeasure)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
        .where(eq(powerbiMeasure.id, ids.base));
      if (held === undefined) throw new Error("the base measure is missing");
      const admin = asPerson(principals.admin, { db: tx });
      await setRole(tx, "api_rw");
      await setRule(admin, {
        kind: "measure",
        table_name: held.table_name,
        name: held.name,
        pii: true,
      });
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      await expect(document(tx, `variant:${ids.baseVariant}`)).rejects.toThrow(
        "no search document",
      );
      await document(tx, `variant:${ids.shiftedVariant}`);
      await document(tx, `metric:${ids.metric}`);
    });
  });

  it("leaves out a metric whose variants are all PII measures", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const admin = asPerson(principals.admin, { db: tx });
      await setRole(tx, "api_rw");
      for (const measure of [ids.base, ids.shifted]) {
        const [held] = await tx
          .select({ table_name: powerbiTable.name, name: powerbiMeasure.name })
          .from(powerbiMeasure)
          .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
          .where(eq(powerbiMeasure.id, measure));
        if (held === undefined) throw new Error("a measure is missing");
        await setRule(admin, {
          kind: "measure",
          table_name: held.table_name,
          name: held.name,
          pii: true,
        });
      }
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      for (const id of [
        `metric:${ids.metric}`,
        `variant:${ids.baseVariant}`,
        `variant:${ids.shiftedVariant}`,
      ])
        await expect(document(tx, id)).rejects.toThrow("no search document");
    });
  });

  it("deletes the documents of an off dataset and restores them when it is on again", async () => {
    await inSampleMirror("worker_rw", async (tx, sample) => {
      const ids = await seedBook(tx, sample);
      const sales = sample.tenant.datasets.find((d) => d.name === SALES);
      const finance = sample.tenant.datasets.find((d) => d.name === FINANCE);
      if (sales === undefined || finance === undefined)
        throw new Error("a sample dataset is missing");
      const [table] = await tx
        .select({ id: powerbiTable.id })
        .from(powerbiTable)
        .where(eq(powerbiTable.dataset_id, sales.id))
        .limit(1);
      const [financeColumn] = await tx
        .select({ id: powerbiColumn.id })
        .from(powerbiColumn)
        .where(eq(powerbiColumn.dataset_id, finance.id))
        .limit(1);
      if (table === undefined || financeColumn === undefined)
        throw new Error("a sample table or column is missing");
      // The term backs a column in each dataset.
      await setRole(tx, "api_rw");
      await tx
        .insert(termColumn)
        .values({ term_id: ids.term, column_id: financeColumn.id });
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      const reach = async (id: string) => (await document(tx, id)).dataset_ids;
      const both = [sales.id, finance.id].sort();
      expect(await reach(`metric:${ids.metric}`)).toEqual(both);
      expect(await reach(`term:${ids.term}`)).toEqual(both);

      const ofSales = [
        `dataset:${sales.id}`,
        `table:${table.id}`,
        `column:${ids.column}`,
        `variant:${ids.baseVariant}`,
      ];
      const admin = asPerson(principals.admin, { db: tx });
      await setRole(tx, "api_rw");
      await setEnabled(admin, SALES, false);
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      for (const id of ofSales)
        await expect(document(tx, id)).rejects.toThrow("no search document");
      expect(await reach(`metric:${ids.metric}`)).toEqual([finance.id]);
      expect(await reach(`term:${ids.term}`)).toEqual([finance.id]);
      await document(tx, `variant:${ids.shiftedVariant}`);

      await setRole(tx, "api_rw");
      await setEnabled(admin, SALES, true);
      await setRole(tx, "worker_rw");
      await buildDocuments(tx);
      for (const id of ofSales) await document(tx, id);
      expect(await reach(`metric:${ids.metric}`)).toEqual(both);
      expect(await reach(`term:${ids.term}`)).toEqual(both);
    });
  });
});
