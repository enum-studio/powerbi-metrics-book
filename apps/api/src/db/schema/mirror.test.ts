import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";
import * as mirror from "./mirror.js";

afterAll(closeTestPools);

/**
 * A workspace, dataset, table, column and measure, made as the sync's role in
 * a transaction that is rolled back. No other connection can see them, so a
 * case that needs api_rw to touch a seeded row cannot be made here.
 */
function withSeed<T>(
  work: (
    worker: pg.PoolClient,
    ids: { workspace: string; dataset: string; table: string; measure: string },
  ) => Promise<T>,
): Promise<T> {
  return inRollback(testPool("worker_rw"), async (worker) => {
    const ids = {
      workspace: randomUUID(),
      dataset: randomUUID(),
      table: randomUUID(),
      measure: randomUUID(),
    };
    // One statement: a foreign key is checked when it ends, so the order does not matter.
    await worker.query(
      `with w as (insert into powerbi_workspace (id, name) values ($1, 'Sample data workspace')),
            d as (insert into powerbi_dataset (id, workspace_id, name) values ($2, $1, 'Sample data dataset')),
            t as (insert into powerbi_table (id, dataset_id, name) values ($3, $2, 'Sample data table')),
            c as (insert into powerbi_column (dataset_id, table_id, name, column_type) values ($2, $3, 'Sample data column', 'data'))
       insert into powerbi_measure (id, dataset_id, table_id, name, expression) values ($4, $2, $3, 'Sample data measure', 'SUM ( 1 )')`,
      [ids.workspace, ids.dataset, ids.table, ids.measure],
    );
    return work(worker, ids);
  });
}

/** A statement run as the given role in a transaction that is rolled back, so a refused one leaves nothing behind. */
function asRole(
  role: "api_rw" | "worker_rw",
  statement: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  return inRollback(testPool(role), (client) =>
    client.query(statement, values),
  );
}

describe("the mirror's tables", () => {
  it("refuses api_rw a measure's expression", async () => {
    await expect(
      asRole(
        "api_rw",
        "update powerbi_measure set expression = 'SUM ( 2 )' where id = $1",
        [randomUUID()],
      ),
    ).rejects.toThrow("permission denied for table powerbi_measure");
  });

  it("lets api_rw describe a measure and file it in a folder", async () => {
    // Postgres checks a column's privilege before it reads a row, so an update
    // that matches nothing still shows the grant.
    const described = await asRole(
      "api_rw",
      "update powerbi_measure set description = 'Sample data', display_folder = 'Sales' where id = $1",
      [randomUUID()],
    );
    expect(described.rowCount).toBe(0);
  });

  it.each([
    [
      "powerbi_access",
      "insert into powerbi_access (object_kind, object_id, principal_type, principal_object_id) values ('app', $1, 'user', $1)",
    ],
    [
      "sync_run",
      "insert into sync_run (id, kind, trigger, status) values ($1, 'full', 'manual', 'running')",
    ],
  ])("refuses api_rw an insert on %s", async (table, statement) => {
    await expect(asRole("api_rw", statement, [randomUUID()])).rejects.toThrow(
      `permission denied for table ${table}`,
    );
  });

  it.each([
    "select * from person_identity",
    "insert into person_identity (user_id) values ('sample-data-user')",
    "update person_identity set groups_read_at = now()",
    "delete from person_identity",
  ])("refuses worker_rw on person_identity: %s", async (statement) => {
    await expect(asRole("worker_rw", statement)).rejects.toThrow(
      "permission denied for table person_identity",
    );
  });

  it("deletes a dataset's tables, columns, measures and relationships with it", async () => {
    const rows = await withSeed(async (worker, { dataset }) => {
      await worker.query(
        "insert into powerbi_relationship (dataset_id, from_table, from_column, to_table, to_column) values ($1, 'a', 'b', 'c', 'd')",
        [dataset],
      );
      await worker.query("delete from powerbi_dataset where id = $1", [
        dataset,
      ]);
      const counted = await worker.query<Record<string, number>>(
        `select (select count(*)::int from powerbi_table where dataset_id = $1) as tables,
                (select count(*)::int from powerbi_column where dataset_id = $1) as columns,
                (select count(*)::int from powerbi_measure where dataset_id = $1) as measures,
                (select count(*)::int from powerbi_relationship where dataset_id = $1) as relationships`,
        [dataset],
      );
      return counted.rows;
    });
    expect(rows).toEqual([
      { tables: 0, columns: 0, measures: 0, relationships: 0 },
    ]);
  });

  it.each([
    [
      "powerbi_column_column_type_check",
      "update powerbi_column set column_type = 'Data' where dataset_id = $1",
    ],
    [
      "powerbi_table_dataset_id_name_key",
      "insert into powerbi_table (dataset_id, name) values ($1, 'Sample data table')",
    ],
    [
      "powerbi_dataset_custom_check",
      "update powerbi_dataset set custom = '[]' where id = $1",
    ],
    [
      "powerbi_access_principal_type_check",
      "insert into powerbi_access (object_kind, object_id, principal_type, principal_object_id) values ('app', $1, 'User', $1)",
    ],
    [
      "sync_run_status_check",
      "insert into sync_run (id, kind, trigger, status) values ($1, 'full', 'manual', 'paused')",
    ],
  ])("refuses a row that breaks %s", async (constraint, statement) => {
    await withSeed((worker, { dataset }) =>
      expect(worker.query(statement, [dataset])).rejects.toThrow(
        `constraint "${constraint}"`,
      ),
    );
  });

  it("lists in each CHECK exactly the values of its TypeScript union", async () => {
    const sets: Record<string, readonly string[]> = {
      powerbi_dataset_relationships_source_check: mirror.RELATIONSHIPS_SOURCES,
      powerbi_column_column_type_check: mirror.COLUMN_TYPES,
      powerbi_access_object_kind_check: mirror.ACCESS_OBJECT_KINDS,
      powerbi_access_principal_type_check: mirror.PRINCIPAL_TYPES,
      sync_run_kind_check: mirror.SYNC_KINDS,
      sync_run_trigger_check: mirror.SYNC_TRIGGERS,
      sync_run_status_check: mirror.SYNC_STATUSES,
    };
    const { rows } = await testPool("api_rw").query<{
      name: string;
      definition: string;
    }>(
      "select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where contype = 'c' and conname = any($1)",
      [Object.keys(sets)],
    );
    const listed = new Map(
      rows.map((row) => [row.name, row.definition.match(/'[a-z_]+'/g) ?? []]),
    );
    for (const [name, values] of Object.entries(sets)) {
      const quoted = (listed.get(name) ?? []).map((value) =>
        value.slice(1, -1),
      );
      expect(quoted.sort(), name).toEqual([...values].sort());
    }
  });

  it("indexes every foreign key, and each dataset's children by (dataset_id, removed_at)", async () => {
    const api = testPool("api_rw");
    const keys = await api.query<{ name: string; indexed: boolean }>(
      `select key.conname as name,
              exists (select from pg_index as idx
                       where idx.indrelid = key.conrelid
                         and (string_to_array(idx.indkey::text, ' ')::int2[])[1:cardinality(key.conkey)] = key.conkey) as indexed
         from pg_constraint as key
        where key.contype = 'f' and key.conrelid::regclass::text like 'powerbi\\_%'`,
    );
    // The rule, whatever the number of keys: each has an index whose leading
    // columns are the key's own.
    expect(keys.rows).not.toEqual([]);
    expect(keys.rows.filter((key) => !key.indexed)).toEqual([]);
    const { rows } = await api.query<{ tablename: string }>(
      "select tablename from pg_indexes where indexdef like '%(dataset_id, removed_at)' order by 1",
    );
    expect(rows.map((row) => row.tablename)).toEqual([
      "powerbi_column",
      "powerbi_measure",
      "powerbi_relationship",
      "powerbi_table",
    ]);
  });
});
