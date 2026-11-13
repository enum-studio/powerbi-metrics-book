import { randomUUID } from "node:crypto";
import { inArray, TransactionRollbackError } from "drizzle-orm";
import { afterAll, beforeAll, expect } from "vitest";
import type { Db, ServiceContext } from "../src/context.js";
import { createDb } from "../src/db/client.js";
import { metric, metricVariant } from "../src/db/schema/book.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
  powerbiWorkspace,
} from "../src/db/schema/mirror.js";
import type { Principal } from "../src/principal.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "./deps.js";
import { MemorySettings } from "./doubles.js";

/*
 * A small tenant after the sample one: Sales is reached by its workspace and
 * by the Sales app, Finance only by the Leadership app, and the old Sales
 * dataset is gone from Power BI. Two datasets share a name in a workspace no
 * list reaches, for the ambiguous lookup. Ids are random per run, so a stale
 * run leaves nothing a list could trip on and test files sharing the database
 * never meet each other's rows. The rows go in the worker's role because the
 * api may not write the mirror.
 */
export const id = {
  sales_workspace: randomUUID(),
  finance_workspace: randomUUID(),
  sales_app: randomUUID(),
  leadership_app: randomUUID(),
  sales: randomUUID(),
  finance: randomUUID(),
  old: randomUUID(),
  sales_table: randomUUID(),
  date_table: randomUUID(),
  finance_table: randomUUID(),
  old_table: randomUUID(),
  channel: randomUUID(),
  order_date: randomUUID(),
  margin: randomUUID(),
  old_column: randomUUID(),
  net_sales: randomUUID(),
  net_sales_ly: randomUUID(),
  profit: randomUUID(),
  days: randomUUID(),
  twin_workspace: randomUUID(),
  twin_a: randomUUID(),
  twin_b: randomUUID(),
};
export const workspaces = [id.sales_workspace, id.finance_workspace];

async function insertMirror(): Promise<void> {
  const db = createDb(testPool("worker_rw"));
  await db.insert(powerbiWorkspace).values([
    { id: id.sales_workspace, name: "Sales" },
    { id: id.finance_workspace, name: "Finance" },
    { id: id.twin_workspace, name: "Twins" },
  ]);
  await db.insert(powerbiApp).values([
    {
      id: id.sales_app,
      name: "Sales app",
      workspace_id: id.sales_workspace,
    },
    {
      id: id.leadership_app,
      name: "Leadership app",
      workspace_id: id.finance_workspace,
    },
  ]);
  await db.insert(powerbiDataset).values([
    {
      id: id.sales,
      workspace_id: id.sales_workspace,
      name: "Sales",
      description_pbi: "Orders and revenue.",
      description: "Every order line since 2024.",
      custom: { tier: "gold" },
    },
    {
      id: id.finance,
      workspace_id: id.finance_workspace,
      name: "Finance",
      has_row_level_security: true,
      schema_error: "The model could not be read.",
      relationships_source: "scanner",
    },
    {
      id: id.twin_a,
      workspace_id: id.twin_workspace,
      name: "Twin",
    },
    {
      id: id.twin_b,
      workspace_id: id.twin_workspace,
      name: "Twin",
    },
    {
      id: id.old,
      workspace_id: id.sales_workspace,
      name: "Sales 2023",
      removed_at: new Date(),
    },
  ]);
  await db.insert(powerbiAppDataset).values([
    { app_id: id.sales_app, dataset_id: id.sales },
    { app_id: id.leadership_app, dataset_id: id.finance },
  ]);
  await db.insert(powerbiTable).values([
    { id: id.sales_table, dataset_id: id.sales, name: "Sales" },
    { id: id.date_table, dataset_id: id.sales, name: "Date", is_hidden: true },
    { id: id.finance_table, dataset_id: id.finance, name: "Ledger" },
    { id: id.old_table, dataset_id: id.old, name: "Legacy" },
  ]);
  await db.insert(powerbiColumn).values([
    {
      id: id.channel,
      dataset_id: id.sales,
      table_id: id.sales_table,
      name: "Channel",
      data_type: "String",
      column_type: "data",
    },
    {
      id: id.order_date,
      dataset_id: id.sales,
      table_id: id.sales_table,
      name: "Order date",
      data_type: "DateTime",
      column_type: "data",
      description_pbi: "When the order was placed.",
    },
    {
      id: id.old_column,
      dataset_id: id.old,
      table_id: id.old_table,
      name: "Legacy channel",
      data_type: "String",
      column_type: "data",
    },
    {
      id: id.margin,
      dataset_id: id.finance,
      table_id: id.finance_table,
      name: "Margin",
      data_type: "Double",
      column_type: "data",
    },
  ]);
  await db.insert(powerbiMeasure).values([
    {
      id: id.net_sales,
      dataset_id: id.sales,
      table_id: id.sales_table,
      name: "Net sales",
    },
    {
      id: id.days,
      dataset_id: id.sales,
      table_id: id.date_table,
      name: "Days in month",
    },
    {
      id: id.profit,
      dataset_id: id.finance,
      table_id: id.finance_table,
      name: "Profit",
    },
    {
      id: id.net_sales_ly,
      dataset_id: id.sales,
      table_id: id.sales_table,
      name: "Net sales LY",
      display_folder: "Time",
    },
  ]);
  await db.insert(powerbiRelationship).values({
    dataset_id: id.sales,
    from_table: "Sales",
    from_column: "Order date",
    to_table: "Date",
    to_column: "Date",
  });
}

/** Puts the tenant in before the file's tests and takes it out, and closes the pools, after them. */
export function useMirror(): void {
  beforeAll(insertMirror);
  afterAll(async () => {
    // Datasets, apps and everything under them go with their workspace.
    await createDb(testPool("worker_rw"))
      .delete(powerbiWorkspace)
      .where(inArray(powerbiWorkspace.id, [...workspaces, id.twin_workspace]));
    await closeTestPools();
  });
}

/** A signed-in person of `role` who reaches what the lists name. */
export const reaching = (
  lists: Principal["attributes"],
  role: keyof typeof principals = "viewer",
): Principal => ({
  ...principals[role],
  attributes: { ...principals[role].attributes, ...lists },
});
export const outsider = reaching({});
export const appReader = reaching({ powerbi_app_ids: [id.sales_app] });
export const leader = reaching({ powerbi_app_ids: [id.leadership_app] });
export const salesMember = reaching({
  powerbi_workspace_ids: [id.sales_workspace],
});
export const everyWorkspace = reaching({ powerbi_workspace_ids: workspaces });

export function asPerson(
  principal: Principal,
  options: { db?: Db; mode?: "powerbi" | "everyone" } = {},
): ServiceContext {
  const access = cerbosAccess(
    new MemorySettings({ "access.metadata_visibility": options.mode }),
  );
  const { db } = options;
  return { ...createTestDeps({ access, ...(db && { db }) }), principal };
}

/**
 * The work runs in a transaction that is rolled back, so the book rows it
 * adds are gone after. A service that opens its own transaction on `tx`
 * makes a savepoint.
 */
export const rolledBack = (work: (tx: Db) => Promise<void>) =>
  expect(
    createDb(testPool("api_rw")).transaction(async (tx) => {
      await work(tx);
      tx.rollback();
    }),
  ).rejects.toThrow(TransactionRollbackError);

/** A curated metric, filed in a category when one is given; returns its id. */
export async function metricIn(
  tx: Db,
  name: string,
  categoryId: string | null = null,
): Promise<string> {
  const [row] = await tx
    .insert(metric)
    .values({ name, label: name, origin: "curator", category_id: categoryId })
    .returning({ id: metric.id });
  return row?.id ?? "";
}

/** Files a measure under the metric, so the metric is seen through the measure's dataset. */
export const fileUnder = (tx: Db, metricId: string, measureId: string) =>
  tx.insert(metricVariant).values({
    metric_id: metricId,
    measure_id: measureId,
    assigned_by: "curator",
  });
