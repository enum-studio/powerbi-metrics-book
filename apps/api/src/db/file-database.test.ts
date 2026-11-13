import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleUrl, TEMPLATE_DATABASE, withAdmin } from "../../test/database.js";

const settingsOf = (database: string) =>
  withAdmin(async (admin) => {
    const { rows } = await admin.query<{ setting: string }>(
      `select unnest(setconfig) as setting from pg_db_role_setting
        where setrole = 0 and setdatabase = (select oid from pg_database where datname = $1)
        order by 1`,
      [database],
    );
    return rows.map((row) => row.setting);
  });

/*
 * A clone does not inherit its template's `alter database` settings, so
 * test/file-database.ts sets them again. Here and not in migrate.test.ts,
 * whose file runs the migration on its own database, which sets them anyway.
 */
it("gives a test file's database every setting a migration gives a deployment's", async () => {
  const migrated = await settingsOf(TEMPLATE_DATABASE);
  expect(migrated).toContain("jit=off");
  const file = new URL(roleUrl("api_rw")).pathname.slice(1);
  expect(await settingsOf(file)).toEqual(migrated);
});

describe("a test that times out", () => {
  const LOCK = 1;
  const open = new pg.Client({ connectionString: roleUrl("worker_rw") });
  const idle = new pg.Client({ connectionString: roleUrl("worker_rw") });

  beforeAll(async () => {
    await open.connect();
    await idle.connect();
    await open.query("begin");
    await open.query("select pg_advisory_xact_lock($1)", [LOCK]);
  });
  afterAll(() => idle.end());

  // Vitest does not stop a test that timed out, so `open` stands for the
  // transaction its body would still hold.
  it.fails(
    "holds a transaction past its limit",
    { timeout: 1 },
    () => new Promise(() => undefined),
  );

  it("leaves the next test nothing to wait on, and sessions in no transaction alone", async () => {
    const { rows } = await idle.query<{ free: boolean }>(
      "select pg_try_advisory_xact_lock($1) as free",
      [LOCK],
    );
    expect(rows).toEqual([{ free: true }]);
    await expect(open.query("select 1")).rejects.toThrow();
  });
});
