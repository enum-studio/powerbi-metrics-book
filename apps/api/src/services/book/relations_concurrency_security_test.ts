import pg from "pg";
import { roleUrl } from "../../../test/database.js";
import { createDb } from "../../db/client.js";
import { createSettingsStore } from "../settings/store.js";
import { setRelation } from "./relations.js";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { closeTestPools, testPool } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import { metric, metricEdge } from "../../db/schema/book.js";
import { createMetric } from "./metrics.js";

afterAll(closeTestPools);

it("the database rejects one of two concurrent opposite edges", async () => {
  const curator = asPerson(reaching({}, "curator"));
  const suffix = randomUUID().replaceAll("-", "");
  const a = await createMetric(curator, {
    name: `a_${suffix}`,
    label: "First",
  });
  const b = await createMetric(curator, {
    name: `b_${suffix}`,
    label: "Second",
  });
  try {
    // These bypass the service lock deliberately: the database is the authority.
    const pool = testPool("api_rw");
    const results = await Promise.allSettled([
      pool.query(
        "insert into metric_edge(parent_id, child_id) values ($1, $2)",
        [a.id, b.id],
      ),
      pool.query(
        "insert into metric_edge(parent_id, child_id) values ($1, $2)",
        [b.id, a.id],
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" ? failed.reason : null).toMatchObject({
      constraint: "metric_edge_cycle_check",
    });
  } finally {
    await curator.db
      .delete(metricEdge)
      .where(inArray(metricEdge.parent_id, [a.id, b.id]));
    await curator.db.delete(metric).where(inArray(metric.id, [a.id, b.id]));
  }
});

it("completes relationship writes with a single database connection", async () => {
  const curator = asPerson(reaching({}, "curator"));
  const suffix = randomUUID().replaceAll("-", "");
  const a = await createMetric(curator, {
    name: `a_${suffix}`,
    label: "First",
  });
  const b = await createMetric(curator, {
    name: `b_${suffix}`,
    label: "Second",
  });
  const pool = new pg.Pool({
    connectionString: roleUrl("api_rw"),
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  const db = createDb(pool);
  const context = { ...curator, db, settings: createSettingsStore(db, {}) };
  try {
    await Promise.all(
      [1, 2].map(() =>
        setRelation(context, a.id, b.id, {
          kind: "edge",
          value: { operation: "sum", sign: 1 },
        }),
      ),
    );
  } finally {
    await curator.db
      .delete(metricEdge)
      .where(inArray(metricEdge.parent_id, [a.id, b.id]));
    await curator.db.delete(metric).where(inArray(metric.id, [a.id, b.id]));
    await pool.end();
  }
});

it.each(["repeatable read", "serializable"])(
  "refuses graph validation against a fixed %s snapshot",
  async (isolation) => {
    const curator = asPerson(reaching({}, "curator"));
    const suffix = randomUUID().replaceAll("-", "");
    const a = await createMetric(curator, {
      name: `a_${suffix}`,
      label: "First",
    });
    const b = await createMetric(curator, {
      name: `b_${suffix}`,
      label: "Second",
    });
    const connection = await testPool("api_rw").connect();
    try {
      await connection.query(
        isolation === "repeatable read"
          ? "begin isolation level repeatable read"
          : "begin isolation level serializable",
      );
      await expect(
        connection.query(
          "insert into metric_edge(parent_id, child_id) values ($1, $2)",
          [a.id, b.id],
        ),
      ).rejects.toMatchObject({ constraint: "metric_edge_isolation_check" });
    } finally {
      await connection.query("rollback");
      connection.release();
      await curator.db.delete(metric).where(inArray(metric.id, [a.id, b.id]));
    }
  },
);
