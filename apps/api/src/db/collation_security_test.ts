import { readFile } from "node:fs/promises";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  makeDatabase,
  roleUrl,
  TEMPLATE_DATABASE,
  withAdmin,
} from "../../test/database.js";
import {
  piiColumnNamed,
  piiMeasure,
  piiTableNamed,
} from "../services/pii/rules.js";
import { migrateDatabase } from "./migrate.js";
import {
  powerbiColumn,
  powerbiMeasure,
  powerbiTable,
} from "./schema/mirror.js";

/*
 * An index keeps the keys and the order it was built with, so after glibc or
 * the Postgres major moves it can miss what is there. Each start rebuilds what
 * depends on the collation when the server has moved, and nothing else. A
 * rebuild gives an index a new relfilenode, which is what most of these compare.
 *
 * A real move takes two servers, so docs/decisions/architecture.md records
 * those runs. Here `lied_fold` stands in for one: it says it is immutable, and
 * answers differently once a row flips, as lower() does when glibc gains a case
 * pair. The btree it leaves behind is really stale.
 */

const rebuild = await readFile(
  new URL("./sql/collation.sql", import.meta.url),
  "utf8",
);

/** The rebuild as shipped, but for how long it waits with no index rebuilt. */
const rebuildWithPatience = (seconds: number): string => {
  const shorter = rebuild.replaceAll(
    "interval '1 minute'",
    `interval '${String(seconds)} seconds'`,
  );
  expect(shorter).not.toBe(rebuild);
  return shorter;
};

const LEFT_ALONE_THOUGH_NOT_BTREE = [
  "search_document_embedding_idx",
  "search_document_search_tsv_idx",
];

const LIED = `
  create table public.lied_server (moved boolean not null);
  insert into public.lied_server values (false);
  create function lied_fold(value text) returns text language sql immutable as
    $$ select case when (select moved from public.lied_server)
         then lower(value) else value end $$;
  create table lied (name text not null, checked boolean);
  create unique index lied_name_idx on lied (lied_fold(name));
  create unique index lied_name_again_idx on lied (lied_fold(name));`;

const STALE_RECORD =
  "comment on index pii_rule_name_idx is 'Built under PostgreSQL 1.0, collation version 0.0.'";

async function onDatabase<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const buildsOf = (url: string): Promise<Map<string, number>> =>
  onDatabase(url, async (client) => {
    const { rows } = await client.query<{ name: string; node: number }>(
      `select relname as name, relfilenode::int as node
         from pg_class
        where relkind = 'i' and relnamespace = 'public'::regnamespace`,
    );
    return new Map(rows.map(({ name, node }) => [name, node]));
  });

/** By the type of each key, so it does not repeat how the rebuild chooses. */
const btreesWithATextKey = (url: string): Promise<string[]> =>
  onDatabase(url, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select relname as name
         from pg_class
         join pg_am on pg_am.oid = relam
        where relkind = 'i' and relnamespace = 'public'::regnamespace
          and amname = 'btree'
          and exists (
            select from pg_attribute
            join pg_type on pg_type.oid = atttypid
            where attrelid = pg_class.oid and typcollation <> 0)`,
    );
    return rows.map(({ name }) => name);
  });

const btreesOf = (url: string): Promise<string[]> =>
  onDatabase(url, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select relname as name
         from pg_class
         join pg_am on pg_am.oid = relam
        where relkind = 'i' and relnamespace = 'public'::regnamespace
          and amname = 'btree'`,
    );
    return rows.map(({ name }) => name);
  });

/** Whether a lock on the table or its indexes waits, in this database alone: clones share oids. */
const isWaitingOn = async (
  client: pg.Client,
  table: string,
): Promise<boolean> => {
  const { rows } = await client.query(
    `select from pg_locks
      where not granted
        and database = (select oid from pg_database where datname = current_database())
        and (relation = $1::regclass
          or relation in (select indexrelid from pg_index where indrelid = $1::regclass))`,
    [table],
  );
  return rows.length > 0;
};

const recordOf = (url: string): Promise<string | null> =>
  onDatabase(url, async (client) => {
    const { rows } = await client.query<{ record: string | null }>(
      "select obj_description('pii_rule_name_idx'::regclass, 'pg_class') as record",
    );
    return rows[0]?.record ?? null;
  });

const collationOf = (url: string) =>
  onDatabase(url, async (client) => {
    const { rows } = await client.query<{
      recorded: string | null;
      actual: string | null;
    }>(
      `select datcollversion as recorded,
              pg_database_collation_actual_version(oid) as actual
         from pg_database where datname = current_database()`,
    );
    const [versions] = rows;
    if (versions === undefined) throw new Error("No such database.");
    return versions;
  });

async function expectRebuilt(
  url: string,
  before: Map<string, number>,
  after: Map<string, number>,
): Promise<void> {
  const withText = new Set(await btreesWithATextKey(url));
  // A guard on the query above: the schema has dozens of these.
  expect(withText.size).toBeGreaterThan(50);
  for (const name of await btreesOf(url)) {
    if (withText.has(name)) expect(after.get(name)).not.toBe(before.get(name));
    else expect(after.get(name)).toBe(before.get(name));
  }
  for (const name of LEFT_ALONE_THOUGH_NOT_BTREE) {
    expect(after.has(name)).toBe(true);
    expect(after.get(name)).toBe(before.get(name));
  }
}

const made: string[] = [];

afterAll(() =>
  withAdmin(async (admin) => {
    for (const name of made) await dropDatabase(admin, name);
  }),
);

/** A clone of the migrated template, as the migrator's URL. */
async function clone(options = ""): Promise<string> {
  const { name, url } = await makeDatabase(
    `template ${pg.escapeIdentifier(TEMPLATE_DATABASE)} strategy file_copy ${options}`,
  );
  made.push(name);
  return url;
}

describe("a start's check of what the indexes were built under", () => {
  /** Moves `lied_fold`, and marks the server as moved. */
  async function moveFold(url: string): Promise<void> {
    await onDatabase(url, async (client) => {
      await client.query("update public.lied_server set moved = true");
      await client.query(STALE_RECORD);
    });
  }

  it("rebuilds nothing when the server has not moved", async () => {
    const url = roleUrl("migrator");
    const before = await buildsOf(url);
    await migrateDatabase(url);
    expect(await buildsOf(url)).toEqual(before);
  });

  it("locks no table when the server has not moved", async () => {
    const locked = await onDatabase(roleUrl("migrator"), async (client) => {
      await client.query("begin");
      await client.query(rebuild);
      const { rows } = await client.query<{ name: string }>(
        `select relname as name
           from pg_locks
           join pg_class on pg_class.oid = relation
          where pid = pg_backend_pid() and relnamespace = 'public'::regnamespace`,
      );
      await client.query("rollback");
      return rows;
    });
    expect(locked).toEqual([]);
  });

  it.each([
    ["another server, or a version refreshed by hand", STALE_RECORD],
    [
      "no record, as on the first start with this check",
      "comment on index pii_rule_name_idx is null",
    ],
  ])("rebuilds under %s", async (_case, statement) => {
    const url = roleUrl("migrator");
    const current = await recordOf(url);
    expect(current).toMatch(/^Built under PostgreSQL .*collation version/);
    await onDatabase(url, (client) => client.query(statement));
    const before = await buildsOf(url);
    await migrateDatabase(url);
    await expectRebuilt(url, before, await buildsOf(url));
    expect(await recordOf(url)).toBe(current);
  });

  it("rebuilds and refreshes when only the database's version differs", async () => {
    const url = await clone("collation_version = '0.0'");
    expect((await collationOf(url)).recorded).toBe("0.0");
    const before = await buildsOf(url);
    await migrateDatabase(url);
    const after = await buildsOf(url);
    await expectRebuilt(url, before, after);
    const { recorded, actual } = await collationOf(url);
    expect(recorded).toBe(actual);

    await migrateDatabase(url);
    expect(await buildsOf(url)).toEqual(after);
  });

  it("finds through a rebuilt index what the stale one missed", async () => {
    const url = await clone();
    const lookup = async () =>
      onDatabase(url, async (client) => {
        await client.query("set enable_seqscan = off");
        await client.query("set enable_bitmapscan = off");
        const { rows } = await client.query<{ found: number }>(
          "select count(*)::int as found from lied where lied_fold(name) = lied_fold('MixedCase')",
        );
        return rows[0]?.found;
      });
    await onDatabase(url, async (client) => {
      await client.query(LIED);
      await client.query("insert into lied values ('MixedCase')");
      // The fold in an expression and in a predicate with no text key, and a
      // trigram index, which lower-cases under the collation though it is no btree.
      await client.query(
        `create index lied_expression_idx on lied ((lied_fold(name) = 'a'));
         create index lied_predicate_idx on lied (checked) where lied_fold(name) = 'a';
         create index lied_trigram_idx on lied using gin (name gin_trgm_ops)`,
      );
    });
    expect(await lookup()).toBe(1);

    await moveFold(url);
    const before = await buildsOf(url);
    expect(await lookup()).toBe(0);
    await migrateDatabase(url);
    expect(await lookup()).toBe(1);
    const after = await buildsOf(url);
    for (const name of [
      "lied_expression_idx",
      "lied_predicate_idx",
      "lied_trigram_idx",
    ])
      expect(after.get(name)).not.toBe(before.get(name));
  });

  it("names every index two rows hold up, never the key, and finishes once they are gone", async () => {
    const url = await clone();
    const collation = await collationOf(url);
    await onDatabase(url, async (client) => {
      await client.query(LIED);
      await client.query(
        "insert into lied values ('DuplicatedKey'), ('duplicatedkey')",
      );
    });
    await moveFold(url);
    const stale = await recordOf(url);

    const error: unknown = await migrateDatabase(url).catch(
      (failure: unknown) => failure,
    );
    if (!(error instanceof pg.DatabaseError))
      throw new Error("The start did not fail on the duplicate.");
    expect(error.message).toContain("lied_name_idx");
    expect(error.message).toContain("lied_name_again_idx");
    expect(error.detail).toBeUndefined();
    expect(
      JSON.stringify([error.message, Object.entries(error)]).toLowerCase(),
    ).not.toContain("duplicatedkey");
    expect(await recordOf(url)).toBe(stale);
    expect(await collationOf(url)).toEqual(collation);

    await onDatabase(url, (client) =>
      client.query("delete from lied where name = 'duplicatedkey'"),
    );
    await migrateDatabase(url);
    expect(await recordOf(url)).not.toBe(stale);
  });

  it("goes on with other indexes, and keeps other tables readable, while a writer holds one", async () => {
    const url = roleUrl("migrator");
    const before = await buildsOf(url);
    await onDatabase(url, (client) => client.query(STALE_RECORD));
    const writer = new pg.Client({ connectionString: roleUrl("api_rw") });
    const reader = new pg.Client({ connectionString: roleUrl("api_rw") });
    await writer.connect();
    await reader.connect();
    try {
      await writer.query("begin");
      await writer.query("lock table pii_rule in row exclusive mode");
      const migrated = migrateDatabase(url);
      while (!(await isWaitingOn(reader, "pii_rule")));

      await reader.query("set lock_timeout = '1s'");
      await reader.query(
        `select (select count(*) from "user"), (select count(*) from setting),
                (select count(*) from role_assignment), (select count(*) from metric),
                (select count(*) from pii_rule)`,
      );
      const elsewhere = before.get("metric_name_key");
      expect(elsewhere).toBeDefined();
      while ((await buildsOf(url)).get("metric_name_key") === elsewhere);

      await writer.query("rollback");
      await migrated;
      await expectRebuilt(url, before, await buildsOf(url));
    } finally {
      await writer.end();
      await reader.end();
    }
  });

  // What a sync does: it reads a table and writes it later in one transaction, so
  // the read keeps the rebuild off the index while the rebuild keeps the write off
  // the table. Postgres ends whichever waited longest, and a sync it ends ends its
  // run. These write as the rebuild begins its wait, and once its first wait is over.
  it.each([0, 1_200])(
    "lets a transaction that reads a table and then writes it, %i ms into the wait, finish",
    async (delay) => {
      const url = roleUrl("migrator");
      const before = await buildsOf(url);
      await onDatabase(url, (client) => client.query(STALE_RECORD));
      const sync = new pg.Client({ connectionString: roleUrl("worker_rw") });
      const watcher = new pg.Client({ connectionString: url });
      await sync.connect();
      await watcher.connect();
      try {
        await sync.query("begin");
        await sync.query("select count(*) from powerbi_table");
        const migrated = migrateDatabase(url);
        while (!(await isWaitingOn(watcher, "powerbi_table")));
        await new Promise((done) => setTimeout(done, delay));

        await sync.query("update powerbi_table set name = name");
        await sync.query("commit");
        await migrated;
        await expectRebuilt(url, before, await buildsOf(url));
      } finally {
        await sync.end();
        await watcher.end();
      }
    },
  );

  // Here the sync queues behind the rebuild's wait for the table. When the other
  // writer commits, the rebuild takes the table and only then waits for the index,
  // after the sync began to wait: a rebuild that stays that long costs the sync its run.
  it("lets that transaction finish when another writer lets the rebuild in behind it", async () => {
    const url = roleUrl("migrator");
    const before = await buildsOf(url);
    await onDatabase(url, (client) => client.query(STALE_RECORD));
    const sync = new pg.Client({ connectionString: roleUrl("worker_rw") });
    const other = new pg.Client({ connectionString: roleUrl("worker_rw") });
    const watcher = new pg.Client({ connectionString: url });
    await sync.connect();
    await other.connect();
    await watcher.connect();
    try {
      await sync.query("begin");
      await sync.query("select count(*) from powerbi_table");
      await other.query("begin");
      await other.query("update powerbi_table set name = name");
      const migrated = migrateDatabase(url);
      while (!(await isWaitingOn(watcher, "powerbi_table")));

      const write = sync.query("update powerbi_table set name = name");
      // Long enough that a rebuild waiting longer than it should would still hold
      // the index when the sync's deadlock check runs, a second after this write.
      await new Promise((done) => setTimeout(done, 350));
      await other.query("commit");
      await write;
      await sync.query("commit");
      await migrated;
      await expectRebuilt(url, before, await buildsOf(url));
    } finally {
      await sync.end();
      await other.end();
      await watcher.end();
    }
  });

  it("gives up after its patience with no index rebuilt, as a wait and not as a duplicate", async () => {
    const url = roleUrl("migrator");
    const before = await buildsOf(url);
    await onDatabase(url, (client) => client.query(STALE_RECORD));
    const stale = await recordOf(url);
    const writer = new pg.Client({ connectionString: roleUrl("api_rw") });
    await writer.connect();
    try {
      await writer.query("begin");
      await writer.query("lock table pii_rule in row exclusive mode");
      await expect(
        onDatabase(url, (client) => client.query(rebuildWithPatience(3))),
      ).rejects.toMatchObject({
        code: "55P03",
        message: expect.stringContaining("pii_rule_name_idx") as string,
      });
      expect(await recordOf(url)).toBe(stale);
      const after = await buildsOf(url);
      expect(after.get("metric_name_key")).not.toBe(
        before.get("metric_name_key"),
      );
      expect(after.get("pii_rule_name_idx")).toBe(
        before.get("pii_rule_name_idx"),
      );
    } finally {
      await writer.end();
    }
    await migrateDatabase(url);
    expect(await recordOf(url)).not.toBe(stale);
  });

  it("counts no build against its patience, so a long rebuild finishes", async () => {
    const url = await clone();
    await onDatabase(url, async (client) => {
      await client.query(
        `create table slow (name text not null);
         insert into slow values ('any');
         create function slow_fold(value text) returns text language plpgsql immutable as $$
           begin
             perform pg_sleep(0.7);
             return value;
           end $$;
         create index slow_a_idx on slow (slow_fold(name));
         create index slow_b_idx on slow (slow_fold(name));
         create index slow_c_idx on slow (slow_fold(name));
         create index slow_d_idx on slow (slow_fold(name));`,
      );
      await client.query(STALE_RECORD);
      const stale = await recordOf(url);
      await client.query(rebuildWithPatience(2));
      expect(await recordOf(url)).not.toBe(stale);
    });
  });

  it("counts no doomed build against its patience, so it names every duplicate", async () => {
    const url = await clone();
    await onDatabase(url, async (client) => {
      await client.query(LIED);
      await client.query(
        `create table doomed (name text not null);
         insert into doomed values ('Twice'), ('twice');
         create function doomed_fold(value text) returns text language plpgsql immutable as $$
           begin
             perform pg_sleep(0.35);
             return public.lied_fold(value);
           end $$;
         create unique index doomed_a_idx on doomed (doomed_fold(name));
         create unique index doomed_b_idx on doomed (doomed_fold(name));
         create unique index doomed_c_idx on doomed (doomed_fold(name));
         create unique index doomed_d_idx on doomed (doomed_fold(name));`,
      );
    });
    await moveFold(url);

    const error: unknown = await onDatabase(url, (client) =>
      client.query(rebuildWithPatience(2)),
    ).catch((failure: unknown) => failure);
    if (!(error instanceof pg.DatabaseError))
      throw new Error("The start did not fail on the duplicates.");
    expect(error.code).toBe("23505");
    for (const name of ["a", "b", "c", "d"])
      expect(error.message).toContain(`doomed_${name}_idx`);
  });

  // A parallel worker logs a duplicate's key before anything can catch the error,
  // on a table of 8 MB or more. The fold says what the build ran with.
  it("builds with no parallel worker", async () => {
    const url = await clone();
    const seen = await onDatabase(url, async (client) => {
      const notices: (string | undefined)[] = [];
      client.on("notice", (notice) => notices.push(notice.message));
      await client.query(
        `create table watched (name text not null);
         insert into watched values ('any');
         create function watched_fold(value text) returns text language plpgsql immutable as $$
           begin
             raise notice '%', current_setting('max_parallel_maintenance_workers');
             return value;
           end $$;
         create index watched_idx on watched (watched_fold(name));`,
      );
      notices.length = 0;
      await client.query(STALE_RECORD);
      await client.query(rebuild);
      return notices;
    });
    expect([...new Set(seen)]).toEqual(["0"]);
  });

  it("rebuilds on a locale that reports no collation version, with nothing to refresh", async () => {
    const { name, url } = await makeDatabase(
      "template template0 encoding 'UTF8' locale 'C.UTF-8'",
    );
    made.push(name);
    await onDatabase(url, (client) =>
      client.query(
        "create table pii_rule (name text); create index pii_rule_name_idx on pii_rule (name)",
      ),
    );
    expect(await collationOf(url)).toEqual({ recorded: null, actual: null });
    const start = () => onDatabase(url, (client) => client.query(rebuild));

    await start();
    const first = await buildsOf(url);
    expect(await recordOf(url)).toMatch(/collation version none\.$/);

    await start();
    expect(await buildsOf(url)).toEqual(first);

    await onDatabase(url, (client) => client.query(STALE_RECORD));
    await start();
    expect((await buildsOf(url)).get("pii_rule_name_idx")).not.toBe(
      first.get("pii_rule_name_idx"),
    );
  });
});

describe("a PII rule lookup", () => {
  it("lets PII win between two rules that fold alike, as a stale unique index allows", async () => {
    const pool = new pg.Pool({ connectionString: await clone() });
    try {
      await pool.query("drop index pii_rule_name_idx");
      await pool.query(
        `insert into pii_rule (kind, table_name, name, pii, set_by_kind, set_by_id, set_via)
           select kind, table_name, name, pii, 'person', 'test', 'cli'
           from (values
             ('table', 'Person', null, false), ('table', 'PERSON', null, true),
             ('table', 'Open', null, false), ('table', 'OPEN', null, false),
             ('column', 'Order', 'Email', true), ('column', 'ORDER', 'EMAIL', false),
             ('column', 'Item', 'Email', false), ('column', 'ITEM', 'EMAIL', true),
             ('table', 'Guest', null, true),
             ('column', 'Guest', 'Note', false), ('column', 'GUEST', 'NOTE', false)
           ) as rule(kind, table_name, name, pii)`,
      );
      const db = drizzle({ client: pool });
      const ask = async (expression: SQL<boolean>) => {
        const { rows } = await db.execute<{ pii: boolean }>(
          sql`select ${expression} as pii`,
        );
        return rows[0]?.pii;
      };
      const table = (name: string) => piiTableNamed(sql`${name}`);
      const column = (name: string, of: string) =>
        piiColumnNamed(sql`${of}`, sql`${name}`);

      expect(await ask(table("person"))).toBe(true);
      expect(await ask(table("open"))).toBe(false);
      expect(await ask(column("email", "order"))).toBe(true);
      expect(await ask(column("email", "item"))).toBe(true);
      expect(await ask(column("note", "guest"))).toBe(false);
      expect(await ask(column("other", "guest"))).toBe(true);
      expect(await ask(column("email", "nowhere"))).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("has no plan that reads a fold index, which a moved server would leave stale", async () => {
    const pool = new pg.Pool({ connectionString: await clone() });
    try {
      // Many rules and few names, so that a plan able to probe the rules by the
      // fold prefers to. A plan chosen on an empty table would hide it.
      await pool.query(
        `insert into powerbi_workspace (id, name, type, state) values
           ('00000000-0000-4000-8000-000000000001', 'Workspace', 'Workspace', 'Active');
         insert into powerbi_dataset (id, workspace_id, name) values
           ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Dataset');
         insert into powerbi_table (id, dataset_id, name) values
           ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'Sales');
         insert into powerbi_column (dataset_id, table_id, name) values
           ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Email');
         insert into powerbi_measure (dataset_id, table_id, name, expression) values
           ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Margin', '1');
         insert into pii_rule (kind, table_name, name, pii, set_by_kind, set_by_id, set_via)
           select kind, 'Table ' || g, case when kind <> 'table' then 'Name ' || g end,
                  true, 'person', 'test', 'cli'
             from generate_series(1, 5000) as g,
                  unnest(array['table', 'column', 'measure']) as kind;
         analyze pii_rule;
         analyze powerbi_table;
         analyze powerbi_column;
         analyze powerbi_measure;`,
      );
      const db = drizzle({ client: pool });
      const inTable = (from: typeof powerbiColumn | typeof powerbiMeasure) =>
        sql`from ${from} inner join ${powerbiTable} on ${powerbiTable.id} = ${from.table_id}`;
      const lookups = [
        {
          lookup: piiTableNamed(powerbiTable.name),
          from: sql`from ${powerbiTable}`,
        },
        {
          lookup: piiColumnNamed(powerbiTable.name, powerbiColumn.name),
          from: inTable(powerbiColumn),
        },
        {
          lookup: piiMeasure(powerbiMeasure),
          from: inTable(powerbiMeasure),
        },
      ];
      const plan = (query: SQL, forced: boolean) =>
        db.transaction(async (tx) => {
          if (forced) {
            await tx.execute(sql`set local enable_seqscan = off`);
            await tx.execute(sql`set local enable_hashjoin = off`);
            await tx.execute(sql`set local enable_mergejoin = off`);
          }
          const { rows } = await tx.execute<{ "QUERY PLAN": string }>(
            sql`explain (costs off) ${query}`,
          );
          return rows.map((row) => row["QUERY PLAN"]).join("\n");
        });
      for (const { lookup, from } of lookups)
        for (const query of [
          sql`select ${lookup} ${from}`,
          sql`select count(*) ${from} where ${lookup}`,
          sql`select count(*) ${from} where not ${lookup}`,
        ])
          for (const forced of [false, true]) {
            const text = await plan(query, forced);
            expect(text).toContain("pii_rule");
            expect(text).not.toMatch(/Index Cond:[^\n]*normalize/i);
          }
    } finally {
      await pool.end();
    }
  });
});
