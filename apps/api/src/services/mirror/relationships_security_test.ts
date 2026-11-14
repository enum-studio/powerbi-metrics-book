import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { TEST_RUNNER } from "../../../test/database.js";
import { testPool } from "../../../test/deps.js";
import { setRole } from "../../../test/sample-mirror.js";
import { createDb } from "../../db/client.js";
import { powerbiColumn, powerbiRelationship } from "../../db/schema/mirror.js";
import {
  appReader,
  asPerson,
  id,
  outsider,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import { piiRule } from "../../db/schema/pii.js";
import { NO_SUCH_DATASET } from "../../errors.js";
import * as mirror from "./read.js";

useMirror();

it("hides PII relationship ends and column names, and counts the omitted joins", () =>
  rolledBack(async (tx) => {
    await tx.insert(piiRule).values({
      kind: "column",
      table_name: "Sales",
      name: "Order date",
      pii: true,
      set_by_kind: "person",
      set_by_id: "x",
      set_via: "api",
    });
    const context = asPerson(appReader, { db: tx });
    expect(
      await mirror.listRelationships(context, { dataset: id.sales }),
    ).toMatchObject({ items: [], total: 0, pii_hidden: 1, next_cursor: null });
    const detail = await mirror.getDataset(context, id.sales);
    expect(detail.tables.find((t) => t.name === "Sales")?.column_names).toEqual(
      ["Channel"],
    );
    expect(detail.date_tables).toEqual([]);
    const reader = asPerson(
      { ...appReader, roles: ["pii_reader"] },
      { db: tx },
    );
    const shown = await mirror.listRelationships(reader, { dataset: id.sales });
    expect(shown.items).toHaveLength(1);
    expect(shown.pii_hidden).toBeUndefined();
    expect(
      (await mirror.getDataset(reader, id.sales)).tables.find(
        (t) => t.name === "Sales",
      )?.column_names,
    ).toContain("Order date");
  }));

it("gives a table its kind from the columns and measures a person is shown", () =>
  rolledBack(async (tx) => {
    await tx.insert(piiRule).values(
      ["Channel", "Order date"].map((name) => ({
        kind: "column" as const,
        table_name: "Sales",
        name,
        pii: true,
        set_by_kind: "person" as const,
        set_by_id: "x",
        set_via: "api" as const,
      })),
    );
    const sales = async (roles: string[]) =>
      (
        await mirror.getDataset(
          asPerson({ ...appReader, roles }, { db: tx }),
          id.sales,
        )
      ).tables.find((t) => t.name === "Sales");
    expect(await sales(appReader.roles)).toMatchObject({
      kind: "measures",
      column_count: 0,
      measure_count: 2,
    });
    expect(await sales([...appReader.roles, "pii_reader"])).toMatchObject({
      kind: "standalone",
      column_count: 2,
    });
  }));

it("keeps hidden relationship counts independent of active_only within each table", () =>
  expect(
    createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
      await setRole(tx, "worker_rw");
      await tx.insert(powerbiRelationship).values({
        dataset_id: id.sales,
        from_table: "Sales",
        from_column: "Order date",
        to_table: "Date",
        to_column: "Other date",
        is_active: false,
      });
      await setRole(tx, "api_rw");
      await tx.insert(piiRule).values({
        kind: "column",
        table_name: "Sales",
        name: "Order date",
        pii: true,
        set_by_kind: "person",
        set_by_id: "x",
        set_via: "api",
      });
      const context = asPerson(appReader, { db: tx });
      for (const table of [undefined, "Sales", id.date_table, "Absent"]) {
        const all = await mirror.listRelationships(context, {
          dataset: id.sales,
          table,
        });
        const active = await mirror.listRelationships(context, {
          dataset: id.sales,
          table,
          active_only: true,
        });
        expect(all.pii_hidden).toBe(2);
        expect(active.pii_hidden).toBe(all.pii_hidden);
      }
      tx.rollback();
    }),
  ).rejects.toThrow(TransactionRollbackError));

it("hides date columns at either one end and excludes date-named string columns", () =>
  expect(
    createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
      await setRole(tx, "worker_rw");
      await tx.insert(powerbiColumn).values([
        {
          dataset_id: id.sales,
          table_id: id.date_table,
          name: "Date",
          data_type: "Date",
        },
        {
          dataset_id: id.sales,
          table_id: id.sales_table,
          name: "Date label",
          data_type: "String",
        },
      ]);
      await tx.insert(powerbiRelationship).values([
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Channel",
          to_table: "Date",
          to_column: "Date",
          cardinality: "many_to_one",
        },
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Order date",
          to_table: "Date",
          to_column: "Date",
          cardinality: "one_to_many",
        },
        {
          dataset_id: id.sales,
          from_table: "Sales",
          from_column: "Date label",
          to_table: "Sales",
          to_column: "Channel",
          cardinality: "one_to_many",
        },
      ]);
      await setRole(tx, "api_rw");
      await tx.insert(piiRule).values([
        {
          kind: "column",
          table_name: "Sales",
          name: "Order date",
          pii: true,
          set_by_kind: "person",
          set_by_id: "x",
          set_via: "api",
        },
        {
          kind: "column",
          table_name: "Date",
          name: "Date",
          pii: true,
          set_by_kind: "person",
          set_by_id: "x",
          set_via: "api",
        },
      ]);
      expect(
        (await mirror.getDataset(asPerson(appReader, { db: tx }), id.sales))
          .date_tables,
      ).toEqual([]);
      const reader = asPerson(
        { ...appReader, roles: ["pii_reader"] },
        { db: tx },
      );
      expect((await mirror.getDataset(reader, id.sales)).date_tables).toEqual([
        { table: "Date", column: "Date", joined_by: 1 },
        { table: "Sales", column: "Order date", joined_by: 1 },
      ]);
      tx.rollback();
    }),
  ).rejects.toThrow(TransactionRollbackError));

it("answers a refused dataset exactly like a missing one and getDataset", async () => {
  for (const dataset of [id.sales, "Sales", randomUUID()]) {
    for (const lookup of [
      () => mirror.listRelationships(asPerson(outsider), { dataset }),
      () => mirror.getDataset(asPerson(outsider), dataset),
    ]) {
      await expect(lookup()).rejects.toMatchObject({
        kind: "not_found",
        message: NO_SUCH_DATASET,
      });
    }
  }
});
