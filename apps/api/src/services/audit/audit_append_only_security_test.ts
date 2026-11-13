import { DatabaseError } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, type Role } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";

/*
 * Every access is accountable only while nobody can rewrite the record:
 * audit_event takes inserts from audit_writer, and no role but its owner, the
 * migrator, may update or delete a row of it.
 */

const INSERT = `insert into audit_event (principal_kind, principal_id, via, action, decision)
                values ('person', 'test-append-only', 'browser', 'settings.set', 'allow')`;

/** Runs sql as role in a transaction that is rolled back; the Postgres error code, or null when it ran. */
async function attempt(role: Role, sql: string): Promise<string | null> {
  return inRollback(testPool(role), async (client) => {
    try {
      await client.query(sql);
      return null;
    } catch (error) {
      if (error instanceof DatabaseError && error.code !== undefined)
        return error.code;
      throw error;
    }
  });
}

const PERMISSION_DENIED = "42501";

afterAll(closeTestPools);

describe("audit_event", () => {
  it("takes an insert from audit_writer", async () => {
    expect(await attempt("audit_writer", INSERT)).toBeNull();
  });

  it.each(["audit_writer", "api_rw", "worker_rw"] as const)(
    "refuses %s an update, a delete and a truncate",
    async (role) => {
      expect(
        await attempt(role, "update audit_event set reason = 'rewritten'"),
      ).toBe(PERMISSION_DENIED);
      expect(await attempt(role, "delete from audit_event")).toBe(
        PERMISSION_DENIED,
      );
      expect(await attempt(role, "truncate audit_event")).toBe(
        PERMISSION_DENIED,
      );
    },
  );
});

// A query has one record, here, written by the same insert-only role.
const LOG_INSERT = `insert into query_log (id, at, principal_kind, principal_id, via, dax, dax_hash, status, duration_ms)
                    values (gen_random_uuid(), now(), 'person', 'test-append-only', 'mcp', 'EVALUATE {1}', 'hash', 'succeeded', 1)`;

describe("query_log", () => {
  it("takes an insert from audit_writer, which cannot read it", async () => {
    expect(await attempt("audit_writer", LOG_INSERT)).toBeNull();
    expect(await attempt("audit_writer", "select id from query_log")).toBe(
      PERMISSION_DENIED,
    );
  });

  it.each(["audit_writer", "api_rw", "worker_rw"] as const)(
    "refuses %s an update, a delete and a truncate",
    async (role) => {
      expect(
        await attempt(role, "update query_log set error = 'rewritten'"),
      ).toBe(PERMISSION_DENIED);
      expect(await attempt(role, "delete from query_log")).toBe(
        PERMISSION_DENIED,
      );
      expect(await attempt(role, "truncate query_log")).toBe(PERMISSION_DENIED);
    },
  );
});
