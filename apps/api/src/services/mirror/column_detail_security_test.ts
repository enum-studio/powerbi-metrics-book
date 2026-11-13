import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPool } from "../../../test/deps.js";
import {
  appReader,
  asPerson,
  id,
  outsider,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { powerbiMeasure, powerbiRelationship } from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { NO_SUCH_DATASET } from "../../errors.js";
import { getColumnDetail } from "./read.js";

useMirror();

/*
 * One column's detail answers a dataset or a column the caller may not see
 * exactly as it answers one that does not exist, and never names a PII
 * measure to a caller who may not read PII.
 */

const reader = { ...appReader, roles: ["pii_reader"] };
const rule = (kind: "column" | "measure", name: string) => ({
  kind,
  table_name: "Sales",
  name,
  pii: true,
  set_by_kind: "person",
  set_by_id: "x",
  set_via: "api",
});

const withPiiRules = (tx: Db) =>
  tx
    .insert(piiRule)
    .values([rule("column", "Order date"), rule("measure", "Net sales")]);

// Only the sync writes a measure's DAX, so the worker sets it, and it is cleared after.
const worker = createDb(testPool("worker_rw"));
beforeAll(async () => {
  for (const measure of [id.net_sales, id.net_sales_ly])
    await worker
      .update(powerbiMeasure)
      .set({ expression: "COUNT(Sales[Channel])" })
      .where(eq(powerbiMeasure.id, measure));
});
afterAll(async () => {
  await worker
    .update(powerbiMeasure)
    .set({ expression: null })
    .where(eq(powerbiMeasure.dataset_id, id.sales));
});

describe("getColumnDetail, for a caller who may not see", () => {
  it("a dataset: not found, as for a dataset that is not there", async () => {
    const answers = [];
    for (const dataset of [id.sales, randomUUID()])
      answers.push(
        await getColumnDetail(asPerson(outsider), dataset, id.channel).catch(
          (error: unknown) => error,
        ),
      );
    expect(answers[0]).toMatchObject({
      kind: "not_found",
      message: NO_SUCH_DATASET,
    });
    expect(answers[0]).toEqual(answers[1]);
  });

  it("a PII column: not found, as for a column that is not there", () =>
    rolledBack(async (tx) => {
      await withPiiRules(tx);
      const context = asPerson(appReader, { db: tx });
      const hidden = await getColumnDetail(
        context,
        id.sales,
        id.order_date,
      ).catch((error: unknown) => error);
      const missing = await getColumnDetail(
        context,
        id.sales,
        randomUUID(),
      ).catch((error: unknown) => error);
      expect(hidden).toMatchObject({ kind: "not_found" });
      expect(hidden).toEqual(missing);
      const allowed = await getColumnDetail(
        asPerson(reader, { db: tx }),
        id.sales,
        id.order_date,
      );
      expect(allowed.column.name).toBe("Order date");
    }));

  it("a PII measure: used_by leaves it out, and lists it for a PII reader", () =>
    rolledBack(async (tx) => {
      await withPiiRules(tx);
      const names = async (principal: typeof appReader) =>
        (
          await getColumnDetail(
            asPerson(principal, { db: tx }),
            id.sales,
            id.channel,
          )
        ).used_by.map((m) => m.name);
      expect(await names(appReader)).toEqual(["Net sales LY"]);
      expect(await names(reader)).toEqual(["Net sales", "Net sales LY"]);
    }));
});

describe("getColumnDetail relationships", () => {
  it("leaves out a relationship to a PII column, and lists it for a PII reader", async () => {
    const [link] = await worker
      .insert(powerbiRelationship)
      .values({
        dataset_id: id.sales,
        from_table: "Sales",
        from_column: "Channel",
        to_table: "Sales",
        to_column: "Order date",
      })
      .returning({ id: powerbiRelationship.id });
    try {
      await rolledBack(async (tx) => {
        await withPiiRules(tx);
        const ends = async (principal: typeof appReader) =>
          (
            await getColumnDetail(
              asPerson(principal, { db: tx }),
              id.sales,
              id.channel,
            )
          ).relationships.map((r) => `${r.from_column}>${r.to_column}`);
        expect(await ends(appReader)).toEqual([]);
        expect(await ends(reader)).toEqual(["Channel>Order date"]);
      });
    } finally {
      await worker
        .delete(powerbiRelationship)
        .where(eq(powerbiRelationship.id, link?.id ?? ""));
    }
  });
});
