import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { asPerson, rolledBack } from "../../../test/mirror-fixtures.js";
import type { Db, ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { queryResult } from "../../db/schema/queries.js";
import type { Principal } from "../../principal.js";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../powerbi/execute.js", () => ({ executeQuery: request }));
vi.mock("../connection/tokens.js", () => ({
  personPowerBiGrant: () => Promise.resolve({ token: "token", account: null }),
}));

const { executeDax } = await import("./execute.js");

/*
 * executeDax with Power BI replaced by a mock that records its requests, on a
 * dataset of its own whose Customer table holds Email (a PII rule) and Country.
 * The rules go in a transaction that is rolled back; the audit rows are written
 * through the audit role and read back by their random dataset id.
 */

const sfx = randomUUID().slice(0, 8);
const customer = `Customer_${sfx}`;
const ids = { workspace: randomUUID(), dataset: randomUUID() };
const worker = createDb(testPool("worker_rw"));
const reader = createDb(testPool("api_rw"));
const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };

beforeAll(async () => {
  await worker
    .insert(powerbiWorkspace)
    .values({ id: ids.workspace, name: `W ${sfx}` });
  await worker.insert(powerbiDataset).values({
    id: ids.dataset,
    workspace_id: ids.workspace,
    name: `Data ${sfx}`,
    relationships_source: "scanner",
    relationships_read_at: new Date(),
  });
  const tables = await worker
    .insert(powerbiTable)
    .values([
      { dataset_id: ids.dataset, name: customer },
      { dataset_id: ids.dataset, name: `Orders_${sfx}` },
      { dataset_id: ids.dataset, name: `LocalDateTable_${sfx}` },
    ])
    .returning();
  const table = tables.find((row) => row.name === customer);
  const table_id = table?.id ?? "";
  await worker.insert(powerbiColumn).values(
    ["Email", "Country"].map((name) => ({
      dataset_id: ids.dataset,
      table_id,
      name,
    })),
  );
  await worker
    .insert(powerbiMeasure)
    .values({ dataset_id: ids.dataset, table_id, name: "Count" });
  const end = (from_table: string, from_column: string, to_table: string) => ({
    dataset_id: ids.dataset,
    from_table,
    from_column,
    to_table,
    to_column: from_column === "BirthDate" ? "Date" : "Email",
    cardinality: "many_to_one",
  });
  await worker
    .insert(powerbiRelationship)
    .values([
      end(`Orders_${sfx}`, "CustomerEmail", customer),
      end(customer, "BirthDate", `LocalDateTable_${sfx}`),
    ]);
});
afterAll(async () => {
  await worker
    .delete(powerbiWorkspace)
    .where(eq(powerbiWorkspace.id, ids.workspace));
  await closeTestPools();
});
beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({
    columns: [{ name: `${customer}[Country]`, type: "string" }],
    rows: [["DK"]],
    truncated: false,
  });
});

/** A new person for each test, so the audit rows they read are their own. */
const someone = (...roles: string[]): Principal => ({
  ...principals.viewer,
  id: `test-${randomUUID()}`,
  roles: ["viewer", ...roles],
  attributes: {
    ...principals.viewer.attributes,
    powerbi_dataset_ids: [ids.dataset],
  },
});

const contextFor = (
  tx: Db,
  principal: Principal,
  mode: "powerbi" | "everyone" = "powerbi",
): ServiceContext => ({
  ...asPerson(principal, { db: tx, mode }),
  secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
  principal,
});
const markEmail = (tx: Db) =>
  tx.insert(piiRule).values({
    kind: "column",
    table_name: customer,
    name: "Email",
    pii: true,
    ...by,
  });
const run = (context: ServiceContext, dax: string) =>
  executeDax(context, { dataset: ids.dataset, dax });
const denials = (principal: Principal) =>
  reader
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.principal_id, principal.id));
const stored = (tx: Db) =>
  tx.select().from(queryResult).where(eq(queryResult.dataset_id, ids.dataset));

describe("executeDax and PII", () => {
  it("refuses a viewer who names a PII column before Power BI is asked, and audits the refusal", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      const dax = `EVALUATE SELECTCOLUMNS(${customer}, "e", ${customer}[Email])`;
      await expect(run(contextFor(tx, viewer), dax)).rejects.toMatchObject({
        kind: "refused",
        message: `This query uses PII: the table ${customer}, ${customer}[Email]. Use the table's other columns, or ask an admin for the pii_reader role.`,
      });
      expect(request).not.toHaveBeenCalled();
      const [row, ...rest] = await denials(viewer);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        action: "query.pii_refused",
        decision: "deny",
        principal_id: viewer.id,
        resource_kind: "dataset",
        detail: {
          dataset_id: ids.dataset,
          references: [`the table ${customer}`, `${customer}[Email]`],
        },
      });
    }));

  it("refuses a bare PII name and an unsynced name under a measure rule", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: customer,
        name: "Sales",
        pii: true,
        ...by,
      });
      for (const dax of [
        'EVALUATE ROW("x", [email])',
        'EVALUATE ROW("x", [Sales])',
      ])
        await expect(
          run(contextFor(tx, viewer), dax),
          dax,
        ).rejects.toMatchObject({ kind: "refused" });
      expect(request).not.toHaveBeenCalled();
    }));

  it("refuses a service account too", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      const account: Principal = {
        ...viewer,
        kind: "service_account",
        via: "api",
        attributes: {
          ...viewer.attributes,
          powerbi_workspace_ids: [ids.workspace],
        },
      };
      await expect(
        run(contextFor(tx, account, "everyone"), `EVALUATE ${customer}`),
      ).rejects.toThrow("This query uses PII: the table");
      expect(request).not.toHaveBeenCalled();
    }));

  it("lets a viewer run a query that names no PII, and a pii_reader run one that does", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      const piiReader = someone("pii_reader");
      await markEmail(tx);
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Country])`),
      ).resolves.toMatchObject({ row_count: 1 });
      await expect(
        run(contextFor(tx, piiReader), `EVALUATE ${customer}`),
      ).resolves.toMatchObject({ row_count: 1 });
      expect(request).toHaveBeenCalledTimes(2);
    }));

  it("stores nothing when the answer's header is a PII column the walk did not see", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      const piiReader = someone("pii_reader");
      await markEmail(tx);
      request.mockResolvedValue({
        columns: [{ name: `${customer}[EMAIL]`, type: "string" }],
        rows: [["a@example.test"]],
        truncated: false,
      });
      // The name is built at run time, which the token walk cannot read.
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Country])`),
      ).rejects.toThrow(`This query uses PII: ${customer}[EMAIL].`);
      expect(request).toHaveBeenCalledTimes(1);
      expect(await stored(tx)).toEqual([]);
      expect(await denials(viewer)).toHaveLength(1);
      // A pii_reader gets the same answer stored.
      await expect(
        run(contextFor(tx, piiReader), `EVALUATE VALUES(${customer}[Country])`),
      ).resolves.toMatchObject({ row_count: 1 });
    }));

  it("allows a measure on a covered table written with its table, and refuses a column added since the sync", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await tx
        .insert(piiRule)
        .values({ kind: "table", table_name: customer, pii: true, ...by });
      request.mockResolvedValue({
        columns: [{ name: "[n]", type: "number" }],
        rows: [[1]],
        truncated: false,
      });
      await expect(
        run(contextFor(tx, viewer), `EVALUATE ROW("n", ${customer}[Count])`),
      ).resolves.toMatchObject({ row_count: 1 });
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Added])`),
      ).rejects.toMatchObject({ kind: "refused" });
    }));

  it("refuses model-wide functions and line terminators the lexer and engine may read differently", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      for (const dax of [
        "EVALUATE COLUMNSTATISTICS()",
        "EVALUATE DETAILROWS([Count])",
        "EVALUATE INFO.VIEW.COLUMNS()",
      ])
        await expect(run(contextFor(tx, viewer), dax)).rejects.toThrow(
          /^This query uses PII: the function /,
        );
      for (const end of ["\u2028", "\u2029", "\u0085", "\v", "\f", "\r"])
        await expect(
          run(
            contextFor(tx, viewer),
            `EVALUATE ROW("a",1) //${end} EVALUATE ROW("e", MAXX(${customer}, ${customer}[Email]))`,
          ),
        ).rejects.toMatchObject({ kind: "invalid" });
      expect(request).not.toHaveBeenCalled();
    }));

  it("refuses what a relationship joins to a PII column", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      await tx.insert(piiRule).values({
        kind: "column",
        table_name: customer,
        name: "BirthDate",
        pii: true,
        ...by,
      });
      for (const dax of [
        `EVALUATE VALUES(Orders_${sfx}[CustomerEmail])`,
        `EVALUATE VALUES(LocalDateTable_${sfx}[Year])`,
        `EVALUATE SUMMARIZECOLUMNS(${customer}[CustomerKey], 'LocalDateTable_${sfx}'[Date], "n", [Count])`,
      ])
        await expect(run(contextFor(tx, viewer), dax)).rejects.toMatchObject({
          kind: "refused",
        });
      expect(request).not.toHaveBeenCalled();
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(Orders_${sfx}[Amount])`),
      ).resolves.toMatchObject({ row_count: 1 });
    }));

  it("refuses a table named like a keyword, a definition on a covered table and a PII measure named on another table", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await tx
        .insert(piiRule)
        .values({ kind: "table", table_name: "Order", pii: true, ...by });
      await tx.insert(piiRule).values({
        kind: "measure",
        table_name: customer,
        name: "Count",
        pii: true,
        ...by,
      });
      await tx
        .insert(piiRule)
        .values({ kind: "table", table_name: "Covered", pii: true, ...by });
      for (const dax of [
        "EVALUATE Order",
        "EVALUATE VALUES(Order[Fresh])",
        `EVALUATE ROW("x", Orders_${sfx}[Count])`,
        'DEFINE MEASURE Covered[Count] = MAX([Fresh]) EVALUATE ROW("x", [Count])',
      ])
        await expect(
          run(contextFor(tx, viewer), dax),
          dax,
        ).rejects.toMatchObject({ kind: "refused" });
      expect(request).not.toHaveBeenCalled();
    }));

  it("stores nothing when the answer's header is a bare PII name", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      request.mockResolvedValue({
        columns: [{ name: "[Email]", type: "string" }],
        rows: [["a@example.test"]],
        truncated: false,
      });
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Country])`),
      ).rejects.toThrow("This query uses PII: [Email].");
      expect(await stored(tx)).toEqual([]);
    }));

  it("refuses a viewer query when PII relationships are unknown", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await markEmail(tx);
      await tx
        .update(powerbiDataset)
        .set({ relationships_source: null, relationships_read_at: null })
        .where(eq(powerbiDataset.id, ids.dataset));
      const message: unknown = expect.stringContaining(
        "relationships are not known yet",
      );
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Country])`),
      ).rejects.toMatchObject({
        kind: "refused",
        message,
      });
      expect(request).not.toHaveBeenCalled();
      expect(await denials(viewer)).toHaveLength(1);
    }));

  it("does not apply another dataset's table rule to an unknown relationship source", () =>
    rolledBack(async (tx) => {
      const viewer = someone();
      await tx.insert(piiRule).values({
        kind: "table",
        table_name: `Other_${sfx}`,
        pii: true,
        ...by,
      });
      await tx
        .update(powerbiDataset)
        .set({
          relationships_source: "unavailable",
          relationships_read_at: new Date(),
        })
        .where(eq(powerbiDataset.id, ids.dataset));
      await expect(
        run(contextFor(tx, viewer), `EVALUATE VALUES(${customer}[Country])`),
      ).resolves.toMatchObject({ row_count: 1 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(await denials(viewer)).toEqual([]);
    }));
});
