import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testPool,
} from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import {
  powerbiDataset,
  powerbiRelationship,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import type { PiiNames } from "./query-check.js";
import { withRelatedEnds } from "./related.js";

/*
 * Relationships are read from the mirror as the worker wrote them; the names
 * are the ones `piiNamesOf` would have returned, written by hand.
 */

const sets = (entries: Record<string, string[]> = {}) =>
  new Map(Object.entries(entries).map(([t, c]) => [t, new Set(c)]));
const namesWith = (found: Partial<PiiNames> = {}): PiiNames => ({
  columns: sets(),
  bare: new Set(),
  measures: sets(),
  tables: new Set(),
  ruleColumns: sets(),
  ruleMeasures: sets(),
  ruleTables: sets(),
  knownMeasures: sets(),
  ...found,
});

const ids = { workspace: randomUUID(), dataset: randomUUID() };
const worker = createDb(testPool("worker_rw"));
type End = [string, string, string, string, string | null];

async function relate(...ends: End[]) {
  await worker
    .delete(powerbiRelationship)
    .where(eq(powerbiRelationship.dataset_id, ids.dataset));
  await worker.insert(powerbiRelationship).values(
    ends.map(([from_table, from_column, to_table, to_column, cardinality]) => ({
      dataset_id: ids.dataset,
      from_table,
      from_column,
      to_table,
      to_column,
      cardinality,
    })),
  );
}
const related = (names: PiiNames) =>
  withRelatedEnds(createTestDeps().db, ids.dataset, names);

beforeAll(async () => {
  await worker
    .insert(powerbiWorkspace)
    .values({ id: ids.workspace, name: "W" });
  await worker
    .insert(powerbiDataset)
    .values({ id: ids.dataset, workspace_id: ids.workspace, name: "D" });
});
afterAll(async () => {
  await worker
    .delete(powerbiWorkspace)
    .where(eq(powerbiWorkspace.id, ids.workspace));
  await closeTestPools();
});

const birthDate = namesWith({
  ruleColumns: sets({ customer: ["birthdate"] }),
  bare: new Set(["birthdate"]),
  tables: new Set(["customer"]),
});

describe("withRelatedEnds", () => {
  it("makes the table a PII column points to PII whole", async () => {
    await relate(
      ["Customer", "BirthDate", "LocalDateTable_x", "Date", "many_to_one"],
      ["Orders", "CustomerKey", "Customer", "CustomerKey", null],
    );
    const found = await related(birthDate);
    expect(found.tables).toEqual(new Set(["customer", "localdatetable_x"]));
    expect(found.ruleTables).toEqual(sets({ localdatetable_x: [] }));
    // The names it was given are not changed.
    expect(birthDate.ruleTables.size).toBe(0);
  });

  it("adds the foreign key that points to a PII column, and no other column", async () => {
    await relate([
      "Orders",
      "CustomerEmail",
      "Customer",
      "Email",
      "many_to_one",
    ]);
    const found = await related(
      namesWith({
        columns: sets({ customer: ["email"] }),
        bare: new Set(["email"]),
        tables: new Set(["customer"]),
      }),
    );
    expect(found.columns).toEqual(
      sets({ customer: ["email"], orders: ["customeremail"] }),
    );
    expect(found.bare).toEqual(new Set(["email", "customeremail"]));
    expect(found.tables).toEqual(new Set(["customer", "orders"]));
    // The key is PII because of the relationship, which does not make Customer PII whole.
    expect(found.ruleTables.size).toBe(0);
  });

  it("treats a missing cardinality like many to one", async () => {
    await relate(["Orders", "Email", "Customer", "Email", null]);
    const found = await related(
      namesWith({
        columns: sets({ customer: ["email"] }),
        bare: new Set(["email"]),
        tables: new Set(["customer"]),
      }),
    );
    expect(found.columns.get("orders")).toEqual(new Set(["email"]));
  });

  it("swaps the relationship ends for one to many", async () => {
    await relate([
      "Customer",
      "Email",
      "Orders",
      "CustomerEmail",
      "one_to_many",
    ]);
    const found = await related(
      namesWith({
        columns: sets({ customer: ["email"] }),
        bare: new Set(["email"]),
        tables: new Set(["customer"]),
      }),
    );
    expect(found.columns.get("orders")).toEqual(new Set(["customeremail"]));
    expect(found.tables).toEqual(new Set(["customer", "orders"]));
  });

  it("makes the other table PII whole on one to one and many to many, from either end", async () => {
    await relate(
      ["Customer", "Key", "Profile", "Key", "one_to_one"],
      ["Tag", "Key", "Orders", "Key", "many_to_many"],
    );
    const found = await related(
      namesWith({
        ruleColumns: sets({ customer: ["key"], orders: ["key"] }),
        bare: new Set(["key"]),
        tables: new Set(["customer", "orders"]),
      }),
    );
    // A table PII whole makes the table it is one to one with PII whole, back to the first.
    expect(found.ruleTables).toEqual(
      sets({ customer: [], orders: [], profile: [], tag: [] }),
    );
  });

  it("follows relationships to a fixed point", async () => {
    await relate(
      ["Customer", "BirthDate", "Dates", "Date", "many_to_one"],
      ["Dates", "Date", "Calendar", "Date", "one_to_one"],
      ["Sales", "SaleDate", "Calendar", "Date", "many_to_one"],
    );
    const found = await related(birthDate);
    expect(found.ruleTables).toEqual(sets({ dates: [], calendar: [] }));
    expect(found.columns).toEqual(sets({ sales: ["saledate"] }));
  });

  it("reads a column of a ruled table as PII unless it was cleared", async () => {
    await relate(
      ["Customer", "Country", "Country", "Name", "many_to_one"],
      ["Customer", "Email", "Mail", "Address", "many_to_one"],
    );
    const found = await related(
      namesWith({
        tables: new Set(["customer"]),
        ruleTables: sets({ customer: ["country"] }),
      }),
    );
    expect(found.ruleTables).toEqual(sets({ customer: ["country"], mail: [] }));
  });

  it("folds the names it reads as the rules are folded", async () => {
    await relate(["Orders", "ＣustomerＥmail", "Customer", "Email", null]);
    const found = await related(
      namesWith({
        columns: sets({ customer: ["email"] }),
        tables: new Set(["customer"]),
      }),
    );
    expect(found.columns.get("orders")).toEqual(new Set(["customeremail"]));
  });

  it("ignores a relationship the mirror no longer has", async () => {
    await relate(["Customer", "BirthDate", "Gone", "Date", "many_to_one"]);
    await worker
      .update(powerbiRelationship)
      .set({ removed_at: new Date() })
      .where(eq(powerbiRelationship.dataset_id, ids.dataset));
    expect((await related(birthDate)).tables).toEqual(new Set(["customer"]));
  });

  it("does not read the mirror when nothing is hidden", async () => {
    const rejecting = {
      select: () => Promise.reject(new Error("the database was asked")),
    } as unknown as ReturnType<typeof createTestDeps>["db"];
    await expect(
      withRelatedEnds(rejecting, ids.dataset, namesWith()),
    ).resolves.toEqual(namesWith());
  });
});
