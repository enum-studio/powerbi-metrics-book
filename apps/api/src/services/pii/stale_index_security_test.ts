import { eq, type SQL, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import {
  appReader,
  asPerson,
  id,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import {
  powerbiColumn,
  powerbiMeasure,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { foldSql, piiRule } from "../../db/schema/pii.js";
import { listColumns, listMeasures } from "../mirror/read.js";
import { collectDocuments } from "../search/documents.js";
import { piiColumn, piiMeasure, piiNamesOf, piiTableNamed } from "./rules.js";

/*
 * A really stale `pii_rule_name_idx`, the one a glibc upgrade leaves behind. Its
 * own definition is built again with `lower` resolving to a function that says it
 * is immutable and starts to lower text once a row flips, as lower() does when
 * glibc gains a case pair. Every connection here resolves `lower` the same way, so
 * the product's SQL matches the index and the btree truly misses: the first test
 * shows it does. A real move takes two servers; docs/decisions/architecture.md has
 * those runs.
 */
const LYING_PATH = "-c search_path=lie,pg_catalog,public";

useMirror();

let migrator: pg.Client;
let apiPool: pg.Pool;
let workerPool: pg.Pool;
let api: Db;
let worker: Db;

beforeAll(async () => {
  migrator = new pg.Client({ connectionString: roleUrl("migrator") });
  await migrator.connect();
  const { rows } = await migrator.query<{ definition: string }>(
    "select pg_get_indexdef('pii_rule_name_idx'::regclass) as definition",
  );
  await migrator.query(
    `create schema lie;
     create table lie.server (moved boolean not null);
     insert into lie.server values (false);
     create function lie.lower(value text) returns text language sql immutable as
       $$ select case when (select moved from lie.server)
            then pg_catalog.lower(value) else value end $$;
     grant usage on schema lie to api_rw, worker_rw;
     grant select on lie.server to api_rw, worker_rw;
     drop index pii_rule_name_idx;
     set search_path = lie, pg_catalog, public;`,
  );
  await migrator.query(rows[0]?.definition ?? "");
  await migrator.query(
    `insert into pii_rule (kind, table_name, name, pii, set_by_kind, set_by_id, set_via) values
       ('column', 'Sales', 'Channel', true, 'person', 'test', 'cli'),
       ('table', 'Finance', null, true, 'person', 'test', 'cli'),
       ('measure', 'Sales', 'Net sales', true, 'person', 'test', 'cli');
     update lie.server set moved = true;`,
  );
  apiPool = new pg.Pool({
    connectionString: roleUrl("api_rw"),
    options: LYING_PATH,
  });
  workerPool = new pg.Pool({
    connectionString: roleUrl("worker_rw"),
    options: LYING_PATH,
  });
  api = createDb(apiPool);
  worker = createDb(workerPool);
});

afterAll(async () => {
  await migrator.end();
  await apiPool.end();
  await workerPool.end();
});

/** Runs the query as the planner likes, then with only an index left to read by. */
const both = async <T>(query: (db: Db) => Promise<T>): Promise<T[]> => [
  await query(api),
  await api.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_hashjoin = off`);
    await tx.execute(sql`set local enable_mergejoin = off`);
    return query(tx);
  }),
];

describe("with a really stale pii_rule_name_idx", () => {
  it("misses the rule through the index, where a sequential scan finds it", async () => {
    const named = sql`from ${piiRule}
      where ${piiRule.kind} = 'column'
        and ${foldSql(piiRule.table_name)} = ${foldSql(sql`${"Sales"}`)}
        and ${foldSql(sql`coalesce(${piiRule.name}, '')`)} = ${foldSql(sql`${"Channel"}`)}`;
    const reading = (...off: SQL[]) =>
      api.transaction(async (tx) => {
        for (const setting of off) await tx.execute(setting);
        const plan = await tx.execute<{ "QUERY PLAN": string }>(
          sql`explain (costs off) select count(*) ${named}`,
        );
        const { rows } = await tx.execute<{ count: string }>(
          sql`select count(*) ${named}`,
        );
        return {
          plan: plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
          count: rows[0]?.count,
        };
      });

    const through = await reading(sql`set local enable_seqscan = off`);
    expect(through.plan).toMatch(/Index Cond:[^\n]*normalize/i);
    expect(through.count).toBe("0");
    expect(
      await reading(
        sql`set local enable_indexscan = off`,
        sql`set local enable_bitmapscan = off`,
      ),
    ).toMatchObject({ count: "1" });
  });

  it("holds a column rule, a table rule and a measure rule all the same", async () => {
    const column = (db: Db, which: string) =>
      db
        .select({ pii: piiColumn(powerbiColumn, powerbiTable) })
        .from(powerbiColumn)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .where(eq(powerbiColumn.id, which));
    const ask = (expression: SQL<boolean>) => (db: Db) =>
      db.execute<{ pii: boolean }>(sql`select ${expression} as pii`);

    expect(await both((db) => column(db, id.channel))).toEqual([
      [{ pii: true }],
      [{ pii: true }],
    ]);
    expect(await both((db) => column(db, id.order_date))).toEqual([
      [{ pii: false }],
      [{ pii: false }],
    ]);
    const table = await both(ask(piiTableNamed(sql`${"Finance"}`)));
    expect(table.map(({ rows }) => rows[0]?.pii)).toEqual([true, true]);
    const measure = (db: Db) =>
      db
        .select({ pii: piiMeasure(powerbiMeasure) })
        .from(powerbiMeasure)
        .where(eq(powerbiMeasure.id, id.net_sales));
    expect(await both(measure)).toEqual([[{ pii: true }], [{ pii: true }]]);
  });

  it("keeps the column and the measure out of the lists", async () => {
    const context = asPerson(appReader, { db: api });
    const columns = await listColumns(context, { dataset: "Sales" });
    expect(columns.items.map((item) => item.name)).toEqual(["Order date"]);
    expect(columns.pii_hidden).toBe(1);
    const measures = await listMeasures(context, { dataset: "Sales" });
    expect(measures.items.map((item) => item.id)).not.toContain(id.net_sales);
  });

  it("keeps the column out of the search documents, which go to the embedding provider", async () => {
    const documents = await collectDocuments(worker);
    const ids = documents.map((document) => document.element_id);
    expect(ids).toContain(id.order_date);
    expect(ids).not.toContain(id.channel);
    expect(ids).not.toContain(id.net_sales);
  });

  it("gives the query check the rule", async () => {
    const names = await piiNamesOf(api, id.sales);
    expect(names.ruleColumns.get("sales")?.has("channel")).toBe(true);
    expect(names.columns.get("sales")?.has("channel")).toBe(true);
    expect(names.ruleMeasures.get("sales")?.has("net sales")).toBe(true);
  });
});
