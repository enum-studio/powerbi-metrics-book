import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../context.js";
import * as schema from "./schema/index.js";

/** One pool per role a container connects as. The URL is passed as written, so its password is not re-encoded. */
export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
