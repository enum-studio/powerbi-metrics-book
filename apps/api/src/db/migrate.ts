import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { readDatabaseUrl } from "../config.js";
import { applyGrants } from "./grants.js";
// Loaded for its side effect: each schema module declares its grants on import.
import "./schema/index.js";

// src/db and dist/db sit at the same depth, so both paths hold from the
// sources and from the built image alike. tsc copies no .sql file, so the
// image ships src/db/sql beside dist.
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const SQL_FOLDER = fileURLToPath(new URL("../../src/db/sql", import.meta.url));

// Two api replicas starting together would both migrate. The second waits
// here until the first has finished, then finds nothing left to apply.
const MIGRATION_LOCK = "powerbi_metrics_book.migrate";

// How long any statement of the migrations waits for a lock another session
// holds: an open sync on a table, or another start holding the lock above.
// docs/decisions/architecture.md, "A start waits at most 30 seconds for a lock".
const LOCK_NOT_AVAILABLE = "55P03";
const LOCK_TIMEOUT_MS = 30_000;

// Commits after each index it rebuilds, so it cannot join the transaction below.
const REBUILD_FILE = "collation.sql";

/** Drizzle wraps what the driver throws, with the driver's error as `cause`. */
function isLockNotAvailable(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause)
    if (e instanceof pg.DatabaseError && e.code === LOCK_NOT_AVAILABLE)
      return true;
  return false;
}

/**
 * Refuses the start while an invite's end is recorded only in invite.used_at,
 * which migration 0004 drops. The release before 0003 ended invites that way,
 * and the start of 0003's release (5b3701c4) turned each such end into
 * accepted_at or revoked_at. A deployment that skipped that start would
 * otherwise lose the end, and the invite would admit again. Before 0003 the
 * table has no accepted_at, so every used_at end there is unrecorded.
 */
async function refuseUnrecordedInviteEnds(client: pg.Client): Promise<void> {
  const { rows: columns } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'invite'
        and column_name in ('used_at', 'accepted_at')`,
  );
  const names = new Set(columns.map((c) => c.column_name));
  if (!names.has("used_at")) return;
  const { rows } = await client.query<{ unrecorded: number }>(
    names.has("accepted_at")
      ? `select count(*)::int as unrecorded from invite
          where used_at is not null and accepted_at is null and revoked_at is null`
      : `select count(*)::int as unrecorded from invite where used_at is not null`,
  );
  const unrecorded = rows[0]?.unrecorded ?? 0;
  if (unrecorded > 0)
    throw new Error(
      `${String(unrecorded)} invites were ended by a release before migration 0003, and only invite.used_at records it, which this release drops. Deploy 5b3701c4 (pull request 66) first and let it start once: its start records each end. Nothing was applied.`,
    );
}

/**
 * Connected as the migrator: applies every migration the database has not
 * recorded, rebuilds the indexes if the server has moved since they were built,
 * then applies the grants, then the hand-written SQL in src/db/sql in name
 * order. The grants and every SQL file run on each start, so each must leave
 * the database the same however often it runs. They run in one transaction:
 * the grants revoke everything first, and a routine a SQL file grants again
 * (deployment_has_admin) must never be seen without its grant.
 */
export async function migrateDatabase(
  migratorUrl: string,
  { lock_timeout_ms = LOCK_TIMEOUT_MS } = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    // Bounds the wait for the advisory lock and the Drizzle migrations only.
    // The SQL files below are not bounded: a start that fails on a lock held
    // by an open transaction would restart and fail again.
    await client.query("select set_config('lock_timeout', $1, false)", [
      `${String(lock_timeout_ms)}ms`,
    ]);
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [
        MIGRATION_LOCK,
      ]);
      await refuseUnrecordedInviteEnds(client);
      await migrate(drizzle({ client }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    } catch (error) {
      if (isLockNotAvailable(error))
        throw new Error(
          `The migrations waited ${String(lock_timeout_ms / 1000)} s for a lock and gave up. Another session holds it: an open sync on a table, or another start that is still migrating. Nothing it had not committed was applied, and the next start tries again.`,
          { cause: error },
        );
      throw error;
    }
    await client.query("reset lock_timeout");
    await client.query(await readFile(join(SQL_FOLDER, REBUILD_FILE), "utf8"));
    await client.query("begin");
    try {
      await applyGrants(client);
      for (const file of await sqlFiles()) {
        await client.query(await readFile(join(SQL_FOLDER, file), "utf8"));
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    // Ending the session releases the advisory lock with it.
    await client.end();
  }
}

async function sqlFiles(): Promise<string[]> {
  const names = await readdir(SQL_FOLDER);
  return names
    .filter((name) => name.endsWith(".sql") && name !== REBUILD_FILE)
    .sort();
}

if (import.meta.main) {
  await migrateDatabase(readDatabaseUrl(process.env, "MIGRATOR_DATABASE_URL"));
}
