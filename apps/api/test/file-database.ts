import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterAll, afterEach } from "vitest";
import {
  dropDatabase,
  FILE_DATABASE_PREFIX,
  ROLES,
  TEMPLATE_DATABASE,
  TEST_RUNNER,
  useFileDatabase,
  withAdmin,
} from "./database.js";

/*
 * Listed in setupFiles, so it runs in each test file's own context before the
 * file's imports: the file gets a database cloned from the migrated template,
 * and drops it when the file is done. No two files share a row, an advisory
 * lock, an event, a job or a counter.
 *
 * A clone carries the template's tables, grants and extensions, but not the
 * database-level setup the init script and src/db/sql/database.sql do, so that
 * is done here: public loses connect, the roles that connect get it, and JIT
 * is off as in a deployment. The planner has no statistics on rows a test never
 * commits, so a search's estimate can pass JIT's threshold; on a busy machine,
 * compiling then took up to all of its 5 seconds. A setting either of them gains
 * goes here too; file-database.test.ts fails on one that a migration sets, not
 * on one from the init script.
 */

// The time tells global setup's sweep which are old; the bytes keep two files apart.
const name = `${FILE_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const database = pg.escapeIdentifier(name);

await withAdmin(async (admin) => {
  // file_copy writes no WAL for the copy, and the test server keeps its WAL in memory.
  await admin.query(
    `create database ${database} owner migrator template ${pg.escapeIdentifier(TEMPLATE_DATABASE)} strategy file_copy`,
  );
  await admin.query("set role migrator");
  await admin.query(`revoke all on database ${database} from public`);
  await admin.query(
    `grant connect on database ${database} to api_rw, worker_rw, audit_writer, test_runner`,
  );
  await admin.query(`alter database ${database} set jit = off`);
});
useFileDatabase(name);

/*
 * Ending a session fails its client: an idle one's error reaches its pool as an
 * 'error' event, and one in use has no listener of its own. Either throws when
 * nothing listens. A pool the file never ended holds idle sessions, and dropping
 * the database ends them, so once the file is done its pools' errors are dropped.
 * A client still in use then is a leak, and still throws. After a timeout the file
 * has already failed and has ended sessions on purpose, so both are dropped.
 */
let dropping = false;
let timedOut = false;
const emitUnless = (expected: () => boolean) =>
  function (this: EventEmitter, event: string | symbol, ...payload: unknown[]) {
    if (expected() && event === "error" && this.listenerCount("error") === 0)
      return false;
    return EventEmitter.prototype.emit.call(this, event, ...payload);
  };
pg.Pool.prototype.emit = emitUnless(() => dropping || timedOut);
pg.Client.prototype.emit = emitUnless(() => timedOut);

/*
 * Vitest stops waiting for a test that timed out but cannot stop its body, which
 * runs on with its transaction open. The next test to write the same rows then
 * waits on its locks and times out in its turn, so one slow test failed the rest
 * of its file, with nothing in Postgres's log. So a timeout ends the sessions in
 * a transaction here, and waits for them to go, before the next test starts: the
 * body's next statement fails, and its locks are gone. Sessions in no transaction
 * hold none, and stay. pg_stat_activity hides another role's transaction and
 * backend type, but any role may read its user, and pg_locks, where an open
 * transaction holds a lock on its own virtual id. By user, so an autovacuum worker
 * in the database, which test_runner may not end, is left out.
 */
afterEach(async ({ signal }) => {
  if (!signal.aborted) return;
  timedOut = true;
  await withAdmin((admin) =>
    admin.query(
      `select pg_terminate_backend(a.pid, 5000)
         from pg_stat_activity a join pg_locks l on l.pid = a.pid
        where a.datname = $1 and a.usename = any($2)
          and l.locktype = 'virtualxid' and l.granted`,
      [name, [...ROLES, TEST_RUNNER]],
    ),
  );
});

// Registered first, so it runs after the file's own afterAll hooks, which end its pools.
afterAll(() => {
  dropping = true;
  return withAdmin((admin) => dropDatabase(admin, name));
});
