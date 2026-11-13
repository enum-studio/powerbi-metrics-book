import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Db } from "../src/context.js";
import * as schema from "../src/db/schema/index.js";
import { inRollback, type Role } from "./database.js";
import { testPool } from "./deps.js";

/*
 * Work done as one of the database's roles inside a transaction that is
 * rolled back, so a refused statement and an accepted one leave nothing
 * behind, and tests that share the database cannot see each other's rows.
 */

/** One statement, with the role's own connection. */
export function asRole(
  role: Role,
  statement: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  return inRollback(testPool(role), (client) =>
    client.query(statement, values),
  );
}

/** Work through Drizzle, the way a service sees its transaction. */
export function inRolledBack<T>(
  role: Role,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return inRollback(testPool(role), (client) =>
    work(drizzle({ client, schema })),
  );
}
