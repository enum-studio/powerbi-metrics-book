import { createHash, randomUUID } from "node:crypto";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { MemorySecrets } from "../../../test/doubles.js";
import { fileUnder, metricIn } from "../../../test/mirror-fixtures.js";
import {
  loadSampleMirror,
  type SampleMirror,
} from "../../../test/sample-mirror.js";
import {
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import type { ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { powerbiAccess } from "../../db/schema/mirror.js";
import { queryLog } from "../../db/schema/queries.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { personPrincipal } from "../auth/principal.js";
import { assignRole, MICROSOFT } from "../auth/roles.js";
import { listDatasets } from "../mirror/read.js";
import { resultCsv } from "./csv.js";
import { executeDax, readModelView } from "./execute.js";
import { getQuery, searchQueryLog } from "./log.js";
import { createResultStore } from "./store.js";

/*
 * executeDax against the mock's Power BI and the sample tenant's mirror,
 * with each person signed in and connected as the browser does it. Every
 * signed-in person may describe every dataset here, so Power BI alone
 * decides who may query what.
 */

const SALES = "Sales";
const DATASETS = "/powerbi/v1.0/myorg/datasets/";
const api = createDb(testPool("api_rw"));
let f: SignInFixture;
let sample: SampleMirror;

/** The fixture gives people and groups ids of their own; the access lists still name the sample's. */
function renameAccess(tenant: Tenant): void {
  const own = [...tenant.people, ...tenant.groups];
  const original = sampleTenant();
  const ids = new Map(
    [...original.people, ...original.groups].map((item, index) => [
      item.object_id,
      own[index]?.object_id,
    ]),
  );
  for (const item of [...tenant.workspaces, ...tenant.datasets, ...tenant.apps])
    for (const entry of item.users)
      entry.object_id = ids.get(entry.object_id) ?? entry.object_id;
}

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
  renameAccess(f.tenant);
  const mock = await f.settings.get("powerbi.authority");
  await f.settings.set("powerbi.api_url", `${mock}/powerbi`);
  await f.settings.set("access.metadata_visibility", "everyone");
  sample = await loadSampleMirror(createDb(testPool("worker_rw")));
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

function contextFor(principal: Principal, ahead = 0): ServiceContext {
  return {
    ...f.deps,
    access: cerbosAccess(f.settings),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      ["result_link_key", "test-result-link-key"],
    ]),
    clock: () => new Date(Date.now() + ahead),
    principal,
  };
}

/** The person signed in and connected to Power BI, with a clock `ahead` of now. */
async function connected(mailbox: string, ahead = 0) {
  const who = f.person(mailbox);
  const { cookie } = await f.signIn(who, MICROSOFT);
  expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
  const id = await f.userId(who.email);
  return contextFor({ ...principals.viewer, id }, ahead);
}

/**
 * Runs `count` queries at once, each held at Power BI until every other has
 * reached it or been refused, and counts both.
 */
async function inParallel(context: ServiceContext, count: number) {
  let reached = 0;
  let refused = 0;
  const gate = Promise.withResolvers<undefined>();
  const held: ServiceContext = {
    ...context,
    fetcher: {
      ...context.fetcher,
      fetchFixed: async (url, init) => {
        if (String(url).endsWith("/executeQueries")) {
          reached += 1;
          await gate.promise;
        }
        return context.fetcher.fetchFixed(url, init);
      },
    },
  };
  const query = {
    dataset: "Finance",
    dax: "EVALUATE TOPN(12, 'Date')",
  };
  const runs = Array.from({ length: count }, () =>
    executeDax(held, query).catch((error: unknown) => {
      if (!(error instanceof ServiceError) || error.kind !== "rate_limited")
        throw error;
      refused += 1;
    }),
  );
  await vi.waitFor(
    () => {
      expect(reached + refused).toBe(count);
    },
    { timeout: 10_000 },
  );
  gate.resolve(undefined);
  await Promise.all(runs);
  return { reached, refused };
}

const dataset = (name: string) => {
  const found = f.tenant.datasets.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no ${name} in the sample`);
  return found;
};
const recorded = (index: number) =>
  dataset(SALES).recorded_queries[index]?.dax ?? "";

describe("executeDax", () => {
  it("answers an anchor, and logs the query once with its measures and metrics", async () => {
    const admin = await connected("admin");
    const metricId = await metricIn(api, `net_sales_${randomUUID()}`);
    const measure = { dataset: SALES, measure: "Net sales" };
    await fileUnder(api, metricId, sample.measureId(measure));
    const dax = recorded(0);
    const anchor = await executeDax(admin, {
      dataset: SALES,
      dax,
      purpose: "Net sales by month in 2025",
    });
    expect(anchor).toMatchObject({
      dataset: { id: dataset(SALES).id, name: SALES },
      columns: [
        { name: "Date[Month]", type: "string" },
        { name: "[Net sales]", type: "number" },
      ],
      row_count: 12,
      truncated: false,
      truncation_note: null,
      preview_note: null,
      next_offset: null,
    });
    expect(anchor.preview).toHaveLength(12);
    expect(anchor.csv_url).toMatch(
      `${TEST_PUBLIC_BASE_URL}/api/v1/results/${anchor.result_id}/csv?expires=`,
    );
    const day = 24 * 60 * 60_000;
    expect(Date.parse(anchor.expires_at) - Date.now()).toBeGreaterThan(
      day - 60_000,
    );
    await expect(getQuery(admin, anchor.query_id)).resolves.toMatchObject({
      status: "succeeded",
      dax,
      purpose: "Net sales by month in 2025",
      row_count: 12,
      result_id: anchor.result_id,
      measure_names: ["Net sales"],
      metric_ids: [metricId],
    });
    const logged = await searchQueryLog(admin, { mine: true });
    expect(logged.items.map((entry) => entry.id)).toEqual([anchor.query_id]);
    const columnDax = 'EVALUATE ROW("Returned", SUM(Returns[Net sales]))';
    dataset(SALES).recorded_queries.push({ dax: columnDax, rows: [] });
    const column = await executeDax(admin, { dataset: SALES, dax: columnDax });
    await expect(getQuery(admin, column.query_id)).resolves.toMatchObject({
      status: "succeeded",
      measure_names: [],
      metric_ids: [],
    });
  });

  it("stores rows Power BI cut off at its row limit as truncated, with Power BI's sentence", async () => {
    const analyst = await connected("analyst");
    const rows = Array.from({ length: 100_001 }, (_, n) => ({ "Big[N]": n }));
    dataset(SALES).recorded_queries.push({ dax: "EVALUATE 'Big'", rows });
    const anchor = await executeDax(analyst, {
      dataset: SALES,
      dax: "EVALUATE 'Big'",
    });
    expect(anchor).toMatchObject({
      row_count: 100_000,
      truncated: true,
      truncation_note: "More than 100000 rows in a query result",
    });
    await expect(getQuery(analyst, anchor.query_id)).resolves.toMatchObject({
      status: "truncated",
      error: "More than 100000 rows in a query result",
    });
  });

  it("passes a DAX error on as Power BI's sentence, and refuses DAX that is not a query", async () => {
    const viewer = await connected("viewer");
    const sentence =
      "Query (1, 10) Failed to resolve name 'Nope'. It is not a valid table, variable, or function name.";
    const run = (dax: string, name = SALES) =>
      executeDax(viewer, { dataset: name, dax });
    await expect(run("EVALUATE 'Nope'")).rejects.toMatchObject({
      kind: "invalid",
      message: sentence,
    });
    for (const [dax, message] of [
      ["  // nothing\n", "The DAX is empty."],
      [
        "SELECT 1",
        "A DAX query starts with EVALUATE or DEFINE, after any comments.",
      ],
      [
        `EVALUATE '${"x".repeat(100 * 1024)}'`,
        "The DAX is longer than 100 KB.",
      ],
    ])
      await expect(run(dax ?? "")).rejects.toMatchObject({
        kind: "invalid",
        message,
      });
    await expect(run("EVALUATE 'Sales'", randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
    const log = await searchQueryLog(viewer, { mine: true });
    expect(log.items.map(({ status, error }) => [status, error])).toEqual([
      ["refused", NO_SUCH_DATASET],
      ["refused", "The DAX is longer than 100 KB."],
      [
        "refused",
        "A DAX query starts with EVALUATE or DEFINE, after any comments.",
      ],
      ["refused", "The DAX is empty."],
      ["failed", sentence],
    ]);
  });

  it("refuses queries past the daily row budget, saying when it frees up", async () => {
    const leader = await connected("leader");
    await f.settings.set("results.daily_row_budget", 12);
    const first = await executeDax(leader, {
      dataset: "Finance",
      dax: "EVALUATE TOPN(12, 'Date')",
    });
    const ran = await getQuery(leader, first.query_id);
    const frees = new Date(Date.parse(ran.at) + 24 * 60 * 60_000).toISOString();
    await expect(
      executeDax(leader, {
        dataset: "Finance",
        dax: "EVALUATE 'Date'",
      }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      message: `Your queries returned 12 rows in the last 24 hours, past the budget of 12. It frees up at ${frees}.`,
    });
    // Each query in flight holds 100,000 rows: three fit under 12 + 250,000.
    await f.settings.set("results.daily_row_budget", 250_012);
    expect(await inParallel(leader, 10)).toEqual({ reached: 3, refused: 7 });
    // Four in flight at most, whatever the budget.
    await f.settings.set("results.daily_row_budget", 1_000_000);
    expect(await inParallel(leader, 10)).toEqual({ reached: 4, refused: 6 });
  });

  it("leaves catalog rows out of the budget and counts request rows", async () => {
    const caller = await connected("leader", 2 * 24 * 60 * 60_000);
    await f.settings.set("results.daily_row_budget", 1);
    try {
      const catalog = await readModelView(
        caller,
        dataset("Finance").id,
        "MEASURES",
      );
      expect(catalog.row_count).toBeGreaterThan(0);
      const request = await executeDax(caller, {
        dataset: "Finance",
        dax: "EVALUATE TOPN(12, 'Date')",
        purpose: "Read the dataset's measures for the catalog",
      });
      await expect(getQuery(caller, catalog.query_id)).resolves.toMatchObject({
        origin: "catalog",
        result_id: null,
        row_count: null,
      });
      await expect(getQuery(caller, request.query_id)).resolves.toMatchObject({
        origin: "request",
        result_id: request.result_id,
      });
      await expect(
        executeDax(caller, {
          dataset: "Finance",
          dax: "EVALUATE 'Date'",
        }),
      ).rejects.toMatchObject({ kind: "rate_limited" });
    } finally {
      await f.settings.set("results.daily_row_budget", 1_000_000);
    }
  });

  it("counts the rate limit first, then refuses a long purpose or a NUL before anything else, logging what fits", async () => {
    // The limit counts in fixed windows on the clock minute, so all five
    // queries must fall in one for the fifth to be refused.
    let at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const caller = {
      ...contextFor({
        ...principals.viewer,
        id: `nobody-${randomUUID()}`,
      }),
      clock: () => at,
    };
    await f.settings.set("queries.rate_per_minute", 4);
    const nul = "The DAX and the purpose cannot hold a NUL character.";
    const long = `EVALUATE {"${"x".repeat(100 * 1024)}"}`;
    for (const [input, message] of [
      [
        { dax: "EVALUATE {1}", purpose: "p".repeat(2001) },
        "The purpose is longer than 2,000 characters.",
      ],
      [{ dax: "EVALUATE {1}\0" }, nul],
      [{ dax: "EVALUATE {1}", purpose: "Orders\0" }, nul],
      [{ dax: long }, "The DAX is longer than 100 KB."],
    ] as const)
      await expect(
        executeDax(caller, { dataset: "No such dataset", ...input }),
      ).rejects.toMatchObject({ kind: "invalid", message });
    at = new Date(at.getTime() + 59_000);
    await expect(
      executeDax(caller, { dataset: SALES, dax: recorded(1) }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    await f.settings.set("queries.rate_per_minute", 60);
    const logged = await api
      .select({ dax: queryLog.dax, dax_hash: queryLog.dax_hash })
      .from(queryLog)
      .where(eq(queryLog.principal_id, caller.principal.id));
    expect(logged).toHaveLength(5);
    expect(logged).toContainEqual({
      dax: long.slice(0, 100 * 1024),
      dax_hash: createHash("sha256").update(long).digest("hex"),
    });
  });

  it("reads page two, stops a preview and a page at 16 KiB, and streams the CSV the pages hold", async () => {
    const admin = f.person("admin");
    const context = contextFor({
      ...principals.viewer,
      id: await f.userId(admin.email),
    });
    // About 260 bytes a row, a quote, a comma and a line break in each.
    const wide = Array.from({ length: 1200 }, (_, n) => ({
      "Wide[N]": n,
      "Wide[Text]": `"Sample data", row ${String(n)}\n${"x".repeat(220)}`,
      "Wide[Blank]": null,
    }));
    dataset(SALES).recorded_queries.push({
      dax: "EVALUATE 'Wide'",
      rows: wide,
    });
    const anchor = await executeDax(context, {
      dataset: SALES,
      dax: "EVALUATE 'Wide'",
      preview_rows: 100,
    });
    expect(anchor.preview.length).toBeLessThan(100);
    expect(JSON.stringify(anchor.preview).length).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(anchor.preview_note).toBe(
      `Stopped at ${String(anchor.preview.length)} rows to stay under 16 KiB; read on from next_offset.`,
    );
    const store = createResultStore(context);
    const rows: unknown[][] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await store.read(context.principal, anchor.result_id, {
        offset,
        limit: 500,
      });
      expect(page.offset).toBe(offset);
      expect(JSON.stringify(page.rows).length).toBeLessThanOrEqual(16 * 1024);
      rows.push(...page.rows);
      offset = page.next_offset;
    }
    expect(rows).toHaveLength(anchor.row_count);
    expect(rows.slice(0, anchor.preview.length)).toEqual(anchor.preview);
    const quoted = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const expected = [anchor.columns.map((c) => c.name), ...rows]
      .map(
        (row) =>
          `${row.map((v) => (v === null ? "" : quoted(v))).join(",")}\r\n`,
      )
      .join("");
    let csv = "";
    for await (const line of resultCsv(context, anchor.result_id)) csv += line;
    expect(csv).toBe(expected);
  });

  it("refreshes a token Power BI refused once, and answers a second refusal as a missing dataset", async () => {
    const analyst = await connected("analyst", 2 * 60_000);
    const run = () => executeDax(analyst, { dataset: SALES, dax: recorded(1) });
    f.failNext(DATASETS, 401);
    await expect(run()).resolves.toMatchObject({ truncated: false });
    f.failNext(DATASETS, 401);
    f.failNext(DATASETS, 401);
    await expect(run()).rejects.toMatchObject({ kind: "not_found" });
  });

  it("answers needs_connection when Microsoft refuses the refresh, and the connection then needs reconnecting", async () => {
    const reader = await connected("app-reader", 2 * 60_000);
    f.person("app-reader").revoked = true;
    f.failNext(DATASETS, 401);
    await expect(
      executeDax(reader, { dataset: SALES, dax: recorded(1) }),
    ).rejects.toMatchObject({ kind: "needs_connection" });
    const [row] = await f.deps.db
      .select({ status: powerbiConnection.status })
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, reader.principal.id));
    expect(row?.status).toBe("needs_reconnect");
  });

  it("answers Power BI's 403 and 404 as a missing dataset", async () => {
    const outsider = await connected("outsider");
    const run = () =>
      executeDax(outsider, { dataset: SALES, dax: recorded(1) });
    await expect(run()).rejects.toMatchObject({
      kind: "not_found",
      message: NO_SUCH_DATASET,
    });
    f.failNext(DATASETS, 404);
    await expect(run()).rejects.toMatchObject({ kind: "not_found" });
  });
});

it("recovers dataset listing and queries after seven days without activity", async () => {
  const context = await connected("admin", 8 * 24 * 60 * 60_000);
  const who = f.person("admin");
  await createDb(testPool("worker_rw"))
    .insert(powerbiAccess)
    .values({
      object_kind: "dataset",
      object_id: dataset(SALES).id,
      principal_type: "user",
      principal_object_id: who.object_id,
      access_right: "Read",
    });
  await assignRole(
    f.deps.db,
    { role: "viewer", subject_kind: "person", subject: who.email },
    principals.admin,
  );
  await f.settings.set("access.metadata_visibility", "powerbi");
  try {
    context.principal = await personPrincipal(
      context,
      {
        id: context.principal.id,
        email: who.email,
        email_verified: true,
      },
      { via: "browser", client_id: null },
    );
    expect(
      (await listDatasets(context)).items.map((item) => item.id),
    ).toContain(dataset(SALES).id);
    expect(
      await executeDax(context, { dataset: SALES, dax: recorded(0) }),
    ).toMatchObject({ row_count: 12 });
  } finally {
    await f.settings.set("access.metadata_visibility", "everyone");
  }
});
