import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { sql, TransactionRollbackError } from "drizzle-orm";
import type { Db } from "../src/context.js";
import { createDb } from "../src/db/client.js";
import type { GrantedRole } from "../src/db/grants.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../src/db/schema/mirror.js";
import { mirrorSpelling } from "../src/powerbi/scanner.js";
import { type Role, TEST_RUNNER } from "./database.js";
import { testPool } from "./deps.js";

/*
 * The sample tenant's workspaces, apps, datasets, tables, columns and
 * measures in the mirror tables, as a full sync stores them, for tests of
 * what reads the mirror. Access lists and relationships are left out.
 * Workspaces, apps and datasets keep Power BI's ids, so a test finds them in
 * `tenant`; tables, columns and measures get new ids, which the lookups give.
 */

export type SampleMirror = {
  tenant: Tenant;
  measureId(measure: { dataset: string; measure: string }): string;
  columnId(column: { dataset: string; table: string; column: string }): string;
};

export async function loadSampleMirror(tx: Db): Promise<SampleMirror> {
  const tenant = sampleTenant();
  // The sync leaves personal workspaces out.
  const workspaces = tenant.workspaces.filter(
    (w) => w.type !== "PersonalGroup",
  );
  await tx.insert(powerbiWorkspace).values(
    workspaces.map(({ id, name, type, state }) => ({
      id,
      name,
      type: mirrorSpelling(type),
      state: mirrorSpelling(state),
    })),
  );
  await tx.insert(powerbiApp).values(
    tenant.apps.map((app) => ({
      id: app.id,
      name: app.name,
      description_pbi: app.description,
      workspace_id: app.workspace_id,
      published_by: app.published_by,
      last_update: new Date(app.last_update),
    })),
  );
  await tx.insert(powerbiDataset).values(
    tenant.datasets.map((dataset) => ({
      id: dataset.id,
      workspace_id: dataset.workspace_id,
      name: dataset.name,
      description_pbi: dataset.description,
      configured_by: dataset.configured_by,
      target_storage_mode: mirrorSpelling(dataset.storage_mode),
      has_row_level_security: dataset.has_row_level_security,
      schema_error: dataset.schema_retrieval_error,
    })),
  );
  // An app holds the datasets behind its reports.
  const appDatasets = tenant.apps.flatMap((app) => {
    const reports = tenant.reports.filter((r) => app.report_ids.includes(r.id));
    const datasetIds = new Set(reports.map((report) => report.dataset_id));
    return [...datasetIds].map((dataset_id) => ({
      app_id: app.id,
      dataset_id,
    }));
  });
  await tx.insert(powerbiAppDataset).values(appDatasets);

  const ids = new Map<string, string>();
  for (const { id: dataset_id, name: dataset, tables } of tenant.datasets) {
    for (const table of tables) {
      const [stored] = await tx
        .insert(powerbiTable)
        .values({
          dataset_id,
          name: table.name,
          is_hidden: table.hidden,
          description_pbi: table.description,
        })
        .returning();
      if (stored === undefined) throw new Error(`${table.name} was not stored`);
      const table_id = stored.id;
      const columns = table.columns.length
        ? await tx
            .insert(powerbiColumn)
            .values(
              table.columns.map((column) => ({
                dataset_id,
                table_id,
                name: column.name,
                data_type: column.data_type,
                column_type:
                  table.source_expression !== undefined
                    ? ("calculated_table_column" as const)
                    : column.expression !== undefined
                      ? ("calculated" as const)
                      : ("data" as const),
                expression: column.expression ?? null,
                is_hidden: column.hidden,
                description_pbi: column.description,
              })),
            )
            .returning()
        : [];
      for (const c of columns)
        ids.set(`${dataset}/${table.name}/${c.name}`, c.id);
      if (table.measures.length === 0) continue;
      const measures = await tx
        .insert(powerbiMeasure)
        .values(
          table.measures.map((measure) => ({
            dataset_id,
            table_id,
            name: measure.name,
            expression: measure.expression,
            format_string: measure.format_string,
            display_folder: measure.display_folder,
            is_hidden: measure.hidden,
            description_pbi: measure.description,
          })),
        )
        .returning();
      for (const m of measures) ids.set(`${dataset}/${m.name}`, m.id);
    }
  }

  const lookup = (key: string) => {
    const id = ids.get(key);
    if (id === undefined) throw new Error(`The sample mirror has no ${key}`);
    return id;
  };
  return {
    tenant,
    measureId: ({ dataset, measure }) => lookup(`${dataset}/${measure}`),
    columnId: ({ dataset, table, column }) =>
      lookup(`${dataset}/${table}/${column}`),
  };
}

/**
 * Runs `work` as `role` in a transaction that is always rolled back. A
 * service's own transaction nests in it as a savepoint. Not db-roles.ts's
 * inRolledBack: on its connection a service's `begin` is ignored and its
 * `commit` ends the test's transaction. Not secrets-support.ts's rolledBack:
 * it holds the secrets tests' lock and hands out a narrower type than Db.
 */
export async function rolledBack(
  role: Role,
  work: (tx: Db) => Promise<void>,
): Promise<void> {
  await createDb(testPool(role))
    .transaction(async (tx) => {
      await work(tx);
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
}

/** Acts as `role` for the rest of an inSampleMirror transaction. */
export async function setRole(tx: Db, role: GrantedRole): Promise<void> {
  await tx.execute(sql`set local role ${sql.identifier(role)}`);
}

/**
 * Runs `work` as `role` on the sample mirror, which is never committed: the
 * transaction, as the tests' own role, loads it as the worker, acts as
 * `role`, and is always rolled back. Hand `tx` to a service as its database
 * and the service's own transactions become savepoints in it.
 */
export function inSampleMirror(
  role: GrantedRole,
  work: (tx: Db, sample: SampleMirror) => Promise<void>,
): Promise<void> {
  return rolledBack(TEST_RUNNER, async (tx) => {
    await setRole(tx, "worker_rw");
    const sample = await loadSampleMirror(tx);
    await setRole(tx, role);
    await work(tx, sample);
  });
}
