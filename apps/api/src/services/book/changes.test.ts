import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { inRolledBack } from "../../../test/db-roles.js";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { bookChange } from "../../db/schema/book.js";
import { recordBookChange } from "./changes.js";

afterAll(closeTestPools);

const rowsOf = (tx: Db, elementId: string) =>
  tx.select().from(bookChange).where(eq(bookChange.element_id, elementId));

describe("recordBookChange", () => {
  it.each(["api_rw", "worker_rw"] as const)(
    "records who changed what, by which route, as %s",
    async (role) => {
      const id = randomUUID();
      const rows = await inRolledBack(role, async (tx) => {
        await recordBookChange(tx, {
          principal: principals.curator,
          element_kind: "metric",
          element_id: id,
          action: "update",
          before: { label: "Net sales" },
          after: { label: "Net sales excl VAT" },
        });
        return rowsOf(tx, id);
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        principal_kind: "person",
        principal_id: "test-curator",
        via: "browser",
        element_kind: "metric",
        action: "update",
        before: { label: "Net sales" },
        after: { label: "Net sales excl VAT" },
      });
      expect(rows[0]?.at).toBeInstanceOf(Date);
    },
  );

  it("records the sync as the system, and a creation without a before", async () => {
    const id = randomUUID();
    const [row] = await inRolledBack("worker_rw", async (tx) => {
      await recordBookChange(tx, {
        principal: null,
        element_kind: "metric",
        element_id: id,
        action: "create",
        before: null,
        after: { name: "net_sales" },
      });
      return rowsOf(tx, id);
    });
    expect(row).toMatchObject({
      principal_kind: "system",
      principal_id: "sync",
      via: null,
      before: null,
      after: { name: "net_sales" },
    });
  });

  it("leaves no row when the transaction around it rolls back", async () => {
    const db = createDb(testPool("api_rw"));
    const id = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await recordBookChange(tx, {
          principal: principals.admin,
          element_kind: "conventions",
          element_id: id,
          action: "update",
          before: null,
          after: { version: 2 },
        });
        throw new Error("the change failed after it was recorded");
      }),
    ).rejects.toThrow("the change failed after it was recorded");
    expect(await rowsOf(db, id)).toEqual([]);
  });
});
