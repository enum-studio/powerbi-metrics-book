import { sql, TransactionRollbackError } from "drizzle-orm";
import type pg from "pg";
import type { Container } from "../src/context.js";
import { createDb } from "../src/db/client.js";
import { generateIdentity, recipientOf } from "../src/services/secrets/age.js";
import {
  type LoadedIdentity,
  publishRecipient,
} from "../src/services/secrets/identities.js";
import type { SecretsDb } from "../src/services/secrets/store.js";
import { testPool } from "./deps.js";

/*
 * For the tests in src/services/secrets. They share the database: each runs
 * in a transaction that is rolled back, except worker_rotation_security_test,
 * which must commit, because the worker's connection cannot see rows the
 * api's connection has not committed. While its rows exist it holds this lock
 * exclusively; every rolled-back test holds it shared, so none sees them.
 */
const SECRETS_TABLES_LOCK = "powerbi_metrics_book.secrets_tests";

/** Runs work in a transaction that is always rolled back; the store's own transactions nest in it as savepoints. */
export async function rolledBack(
  pool: pg.Pool,
  work: (db: SecretsDb) => Promise<void>,
): Promise<void> {
  const finished = createDb(pool).transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtext(${SECRETS_TABLES_LOCK}))`,
    );
    await work(tx);
    tx.rollback();
  });
  await finished.catch((error: unknown) => {
    if (!(error instanceof TransactionRollbackError)) throw error;
  });
}

/** Runs work that commits rows to the secrets tables while no rolled-back test runs. */
export async function holdingSecretsTables(
  work: () => Promise<void>,
): Promise<void> {
  const client = await testPool("migrator").connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      SECRETS_TABLES_LOCK,
    ]);
    await work();
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [
      SECRETS_TABLES_LOCK,
    ]);
    client.release();
  }
}

export async function newIdentity(): Promise<LoadedIdentity> {
  const identity = await generateIdentity();
  return { identity, recipient: await recipientOf(identity) };
}

/** A fresh identity for each container, published as its current one. */
export async function publishedIdentities(
  db: SecretsDb,
): Promise<Record<Container, LoadedIdentity>> {
  const api = await newIdentity();
  const worker = await newIdentity();
  await publishRecipient(db, "api", api.recipient);
  await publishRecipient(db, "worker", worker.recipient);
  return { api, worker };
}
