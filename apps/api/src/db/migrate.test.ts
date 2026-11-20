import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { type Role, ROLES, roleUrl } from "../../test/database.js";
import { resolve } from "../services/conventions/store.js";
import { migrateDatabase } from "./migrate.js";

const worker = new pg.Pool({ connectionString: roleUrl("worker_rw") });
afterAll(() => worker.end());

/** A new session reads the database's settings as they are now. */
async function newSession<T>(
  role: Role,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(role) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe("a start's migration", () => {
  it("never shows the worker deployment_has_admin without its grant", async () => {
    const state = { migrating: true };
    const migrated = migrateDatabase(roleUrl("migrator")).finally(() => {
      state.migrating = false;
    });
    const refused: string[] = [];
    while (state.migrating)
      await worker
        .query("select deployment_has_admin()")
        .catch((error: unknown) => refused.push(String(error)));
    await migrated;
    expect(refused).toEqual([]);
  });

  it("gives up on a lock another session holds, says so, and leaves the advisory lock free", async () => {
    const holder = new pg.Client({ connectionString: roleUrl("migrator") });
    await holder.connect();
    await holder.query("begin");
    // Drizzle reads its journal first, and wraps the driver's error in its own.
    await holder.query(
      "lock table drizzle.__drizzle_migrations in access exclusive mode",
    );
    const started = Date.now();
    try {
      await expect(
        migrateDatabase(roleUrl("migrator"), { lock_timeout_ms: 500 }),
      ).rejects.toThrow(/waited 0\.5 s for a lock.*next start tries again/s);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    expect(Date.now() - started).toBeLessThan(15_000);
    await newSession("migrator", async (client) => {
      const { rows } = await client.query(
        "select pg_try_advisory_lock(hashtext('powerbi_metrics_book.migrate')) as free",
      );
      expect(rows).toEqual([{ free: true }]);
    });
    await migrateDatabase(roleUrl("migrator"));
  });

  it("gives up on the advisory lock a running start holds", async () => {
    await newSession("migrator", async (holder) => {
      await holder.query(
        "select pg_advisory_lock(hashtext('powerbi_metrics_book.migrate'))",
      );
      await expect(
        migrateDatabase(roleUrl("migrator"), { lock_timeout_ms: 500 }),
      ).rejects.toThrow(/waited 0\.5 s for a lock/);
    });
  });

  it("waits on no open sync once the book's indexes exist", async () => {
    const sync = await worker.connect();
    await sync.query("begin");
    await sync.query(
      "lock table metric, powerbi_measure in row exclusive mode",
    );
    try {
      await migrateDatabase(roleUrl("migrator"));
    } finally {
      await sync.query("rollback");
      sync.release();
    }
  });

  it("lets an open draft run finish when it lays the book's indexes", async () => {
    await newSession("migrator", (migrator) =>
      migrator.query(
        "drop index powerbi_measure_name_words_idx, powerbi_measure_fingerprint_idx, metric_name_trgm_idx, metric_label_trgm_idx",
      ),
    );
    const draftRun = await worker.connect();
    await draftRun.query("begin");
    await draftRun.query("lock table powerbi_measure in row exclusive mode");
    try {
      const migrated = migrateDatabase(roleUrl("migrator"));
      const waiting = () =>
        worker.query(
          "select 1 from pg_locks where relation = 'powerbi_measure'::regclass and not granted",
        );
      while ((await waiting()).rowCount === 0);
      // The drafter's next write. Had the migration taken metric first, this
      // would close the circle and Postgres would abort one of the two.
      await draftRun.query("lock table metric in row exclusive mode");
      await draftRun.query("commit");
      await migrated;
    } finally {
      await draftRun.query("rollback");
      draftRun.release();
    }
    const { rows } = await worker.query(
      "select to_regclass('metric_label_trgm_idx') as index",
    );
    expect(rows).toEqual([{ index: "metric_label_trgm_idx" }]);
  });

  it("turns a stored complete conventions document into the company's part", async () => {
    await newSession("migrator", (migrator) =>
      migrator.query(
        "insert into conventions (version, document, set_by) values (1, $1, 'test-admin')",
        [JSON.stringify(resolve({ preset: "minimal" }))],
      ),
    );
    try {
      await migrateDatabase(roleUrl("migrator"));
      const { rows } = await worker.query(
        "select document from conventions where version = 1",
      );
      const { trust } = resolve({ preset: "minimal" });
      expect(rows).toEqual([
        { document: { format: 1, preset: "minimal", trust } },
      ]);
    } finally {
      await newSession("migrator", (migrator) =>
        migrator.query("delete from conventions"),
      );
    }
  });

  it("leaves JIT off for the next session of every role", async () => {
    // A test file's database starts with JIT off. A deployment already running
    // has never had it, and the setting must reach that one too.
    await newSession("migrator", (migrator) =>
      migrator.query(
        "do $$ begin execute format('alter database %I reset jit', current_database()); end $$",
      ),
    );
    await migrateDatabase(roleUrl("migrator"));
    for (const role of ROLES) {
      const { rows } = await newSession(role, (client) =>
        client.query<{ jit: string }>("show jit"),
      );
      expect(rows).toEqual([{ jit: "off" }]);
    }
  });
});
