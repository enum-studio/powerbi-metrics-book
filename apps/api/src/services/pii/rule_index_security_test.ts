import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";
import { powerbiMeasure } from "../../db/schema/mirror.js";
import { piiMeasure } from "./rules.js";

afterAll(closeTestPools);

/*
 * After a Postgres or glibc upgrade an index on the fold can be stale, and a
 * stale `pii_rule_name_idx` read by the fold misses the rule: the measure then
 * shows, and reaches search and the embedding provider. The planner only
 * reaches for that index when there are many rules, so this file's database
 * holds many, and every other way in is off so that it does whatever the costs
 * say. Reading the index for `kind` alone stays allowed: that finds every
 * measure rule whatever its fold.
 */

beforeAll(async () => {
  const client = new pg.Client({ connectionString: roleUrl("migrator") });
  await client.connect();
  try {
    await client.query(
      `insert into pii_rule (kind, table_name, name, pii, set_by_kind, set_by_id, set_via)
       select 'measure', 'Table ' || i, 'Measure ' || i, true, 'person', 'seed', 'cli'
       from generate_series(1, 5000) i`,
    );
    await client.query("analyze pii_rule");
  } finally {
    await client.end();
  }
}, 30_000);

it("never reads a measure's rule through the index on the fold", async () => {
  const client = await testPool("api_rw").connect();
  try {
    await client.query("begin");
    await client.query("set local enable_hashjoin = off");
    await client.query("set local enable_mergejoin = off");
    await client.query("set local enable_seqscan = off");
    const statement = new PgDialect().sqlToQuery(
      sql`select 1 from ${powerbiMeasure} where ${piiMeasure(powerbiMeasure)}`,
    );
    const { rows } = await client.query<{ "QUERY PLAN": string }>(
      `explain ${statement.sql}`,
      statement.params,
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("pii_rule");
    expect(plan).not.toMatch(
      /pii_rule_name_idx[^\n]*\n\s*Index Cond: [^\n]*normalize/i,
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
});
