import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { metricIn } from "../../../test/mirror-fixtures.js";
import type { ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import {
  getQuery,
  logQuery,
  type QueryLogInput,
  searchQueryLog,
} from "./log.js";

const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const asking = (id: string): ServiceContext => ({
  ...deps,
  principal: { ...principals.viewer, id },
});
const me = asking(`me-${randomUUID()}`);
const sales = {
  id: randomUUID(),
  name: "Sales",
  workspace_id: randomUUID(),
};
let minutes = 0;

afterAll(closeTestPools);

/** Logs a query a minute after the one before, so newest first is a fixed order. */
async function logged(
  dax: string,
  more: Partial<QueryLogInput> = {},
  context = me,
): Promise<string> {
  const id = randomUUID();
  minutes += 1;
  await logQuery(context, {
    id,
    at: new Date(Date.UTC(2026, 9, 25, 9, minutes)),
    dataset: sales,
    dax,
    purpose: null,
    status: "succeeded",
    error: null,
    duration_ms: 40,
    measure_names: [],
    metric_ids: [],
    ...more,
  });
  return id;
}

const ids = (page: { items: { id: string }[] }) => page.items.map((e) => e.id);

describe("searchQueryLog", () => {
  it("finds a query by a word of its DAX, its purpose or its dataset's name, newest first, page by page", async () => {
    const orders = await logged(
      "EVALUATE SUMMARIZECOLUMNS('Channel'[Channel], \"Orders\", [Orders])",
    );
    const months = await logged("EVALUATE 'Date'", {
      purpose: "Orders by month",
    });
    const elsewhere = await logged("EVALUATE 'Date'", {
      dataset: { ...sales, id: randomUUID(), name: "Finance" },
    });
    expect(ids(await searchQueryLog(me, { text: "orders" }))).toEqual([
      months,
      orders,
    ]);
    expect(ids(await searchQueryLog(me, { text: "channel" }))).toEqual([
      orders,
    ]);
    expect(ids(await searchQueryLog(me, { text: "finance" }))).toEqual([
      elsewhere,
    ]);
    const first = await searchQueryLog(me, { mine: true, limit: 2 });
    expect(ids(first)).toEqual([elsewhere, months]);
    const second = await searchQueryLog(me, {
      mine: true,
      limit: 2,
      cursor: first.next_cursor ?? "",
    });
    expect(second).toMatchObject({ next_cursor: null });
    expect(ids(second)).toEqual([orders]);
  });

  it("finds the queries of a metric, by its id or its name", async () => {
    const name = `net_sales_${randomUUID()}`;
    const metricId = await metricIn(createDb(testPool("api_rw")), name);
    const netSales = await logged("EVALUATE {[Net sales]}", {
      measure_names: ["Net sales"],
      metric_ids: [metricId, randomUUID()],
    });
    await logged("EVALUATE {[Orders]}", { metric_ids: [randomUUID()] });
    expect(ids(await searchQueryLog(me, { metric: metricId }))).toEqual([
      netSales,
    ]);
    expect(ids(await searchQueryLog(me, { metric: name }))).toEqual([netSales]);
  });

  it("cuts the DAX at 2,000 characters, and get_query gives all of it", async () => {
    const dax = `EVALUATE {"${"x".repeat(3000)}"}`;
    const id = await logged(dax, {
      status: "failed",
      error: "Query (1, 1) It failed.",
    });
    const [entry] = (await searchQueryLog(me, { status: "failed" })).items;
    expect(entry).toMatchObject({
      id,
      dax_cut: true,
      error: "Query (1, 1) It failed.",
    });
    expect(entry?.dax).toBe(dax.slice(0, 2000));
    await expect(getQuery(me, id)).resolves.toMatchObject({
      dax,
      dax_cut: false,
    });
  });

  it("asks query_log:read with the entry's principal kind and id, leaving out what it refuses", async () => {
    const someoneElse = asking(`other-${randomUUID()}`);
    const theirs = await logged("EVALUATE 'Hidden'", {}, someoneElse);
    const ownOnly = (context: ServiceContext): ServiceContext => ({
      ...context,
      // access/layering_tests/override leaves a principal its own entries.
      access: cerbosAccess(new MemorySettings(), "override"),
    });
    const namesake: ServiceContext = {
      ...someoneElse,
      principal: { ...someoneElse.principal, kind: "service_account" },
    };
    expect(ids(await searchQueryLog(me, { text: "hidden" }))).toEqual([theirs]);
    for (const reader of [ownOnly(me), ownOnly(namesake)]) {
      expect(ids(await searchQueryLog(reader, { text: "hidden" }))).toEqual([]);
      await expect(getQuery(reader, theirs)).rejects.toMatchObject({
        kind: "not_found",
      });
    }
    expect(
      ids(await searchQueryLog(ownOnly(someoneElse), { text: "hidden" })),
    ).toEqual([theirs]);
  });

  it("shows Power BI's sentence only to the principal who ran the query", async () => {
    const someoneElse = asking(`other-${randomUUID()}`);
    const sentence = "Query (1, 10) Failed to resolve name 'Secret'.";
    const id = await logged(
      "EVALUATE 'Secret'",
      { status: "failed", error: sentence },
      someoneElse,
    );
    for (const [reader, error] of [
      [me, null],
      [someoneElse, sentence],
    ] as const) {
      await expect(getQuery(reader, id)).resolves.toMatchObject({
        status: "failed",
        error,
      });
      const [entry] = (await searchQueryLog(reader, { text: "secret" })).items;
      expect(entry).toMatchObject({ id, status: "failed", error });
    }
  });

  it("stores any input whole up to 100 KB, NUL included, and shows 2,000 characters of the purpose", async () => {
    const dax = `EVALUATE {"\0${"x".repeat(200 * 1024)}"}`;
    const purpose = `Orders\0${"y".repeat(150 * 1024)}`;
    const id = await logged(dax, { purpose, status: "refused" });
    const stored = await getQuery(me, id);
    expect(Buffer.byteLength(stored.dax)).toBe(100 * 1024);
    expect(stored.dax.startsWith('EVALUATE {"�xxx')).toBe(true);
    expect(stored.purpose?.length).toBe(100 * 1024 - 2);
    expect(stored.purpose?.startsWith("Orders�yyy")).toBe(true);
    const [entry] = (await searchQueryLog(me, { status: "refused" })).items;
    expect(entry).toMatchObject({ id, dax_cut: true, purpose_cut: true });
    expect(entry?.purpose).toBe(stored.purpose?.slice(0, 2000));
  });

  it("takes a limit from 1 to 100", async () => {
    for (const limit of [0, 101, 1.5])
      await expect(searchQueryLog(me, { limit })).rejects.toMatchObject({
        kind: "invalid",
        message: "limit is a whole number from 1 to 100.",
      });
    await expect(searchQueryLog(me, { limit: 1 })).resolves.toMatchObject({
      items: [{ status: "refused" }],
    });
  });
});
