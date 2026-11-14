import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServiceContext } from "../../context.js";
import { powerbiMeasure } from "../../db/schema/mirror.js";
import type { QueryStatus } from "../../db/schema/queries.js";
import { type GapKind, request, searchLog } from "../../db/schema/usage.js";
import type { Principal } from "../../principal.js";
import { cerbosAccess, createTestDeps } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  fileUnder,
  id,
  metricIn,
  reaching,
  useMirror,
  workspaces,
} from "../../../test/mirror-fixtures.js";
import { logQuery } from "../queries/log.js";
import { usageReport } from "./report.js";

useMirror();

const now = new Date(Date.UTC(2026, 10, 11, 12));
const as = (principal: Principal): ServiceContext => ({
  ...createTestDeps({
    access: cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "powerbi" }),
    ),
    clock: () => now,
  }),
  principal,
});
const curator = as(reaching({ powerbi_workspace_ids: workspaces }, "curator"));
const alice = as({ ...reaching({}), id: "alice" });
const bob = as({ ...reaching({}), id: "bob" });
const personBot = as({ ...reaching({}), id: "bot" });
const bot = as({ ...reaching({}), kind: "service_account", id: "bot" });
const since = new Date(now.getTime() - 3_600_000);
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const iso = (minutes: number) => ago(minutes).toISOString();
const sales = { id: id.sales, name: "Sales", workspace_id: id.sales_workspace };
const salesRef = { kind: "dataset", id: id.sales, name: "Sales" };
const hash = (dax: string) => createHash("sha256").update(dax).digest("hex");
let netSales = "";
const daysAgain = randomUUID();

function searched(
  who: ServiceContext,
  minutes: number,
  query: string,
  hits: string[] = [],
  metric_hit = false,
) {
  return who.auditDb.insert(searchLog).values({
    id: randomUUID(),
    at: ago(minutes),
    principal_kind: who.principal.kind,
    principal_id: who.principal.id,
    via: "mcp",
    query,
    search_mode: "words_only",
    hit_count: hits.length,
    metric_hit,
    top_hits: hits.map((kind) => ({ kind, id: randomUUID(), score: 1 })),
  });
}

function asked(
  who: ServiceContext,
  minutes: number,
  outcome: "answered" | "partly_answered" | "not_answered",
  gaps: GapKind[],
  elements: { kind: string; id: string }[],
) {
  return who.auditDb.insert(request).values({
    id: randomUUID(),
    at: ago(minutes),
    principal_kind: who.principal.kind,
    principal_id: who.principal.id,
    via: "mcp",
    question: `Question from ${who.principal.id}`,
    outcome,
    gaps,
    missing: gaps.length === 0 ? null : "No metric covers it.",
    elements,
  });
}

function ran(
  who: ServiceContext,
  minutes: number,
  status: QueryStatus,
  measures: string[],
  options: { metric?: string; dax?: string; purpose?: string; id?: string },
) {
  return logQuery(who, {
    id: options.id ?? randomUUID(),
    at: ago(minutes),
    dataset: sales,
    dax: options.dax ?? `EVALUATE {${String(minutes)}}`,
    purpose: options.purpose ?? null,
    status,
    error: null,
    duration_ms: 20,
    measure_names: measures,
    metric_ids: options.metric === undefined ? [] : [options.metric],
  });
}

beforeAll(async () => {
  const { db } = curator;
  netSales = await metricIn(db, "net_sales");
  await fileUnder(db, netSales, id.net_sales);
  await db
    .update(powerbiMeasure)
    .set({ description: "Last year's net sales." })
    .where(eq(powerbiMeasure.id, id.net_sales_ly));

  await searched(alice, 50, "Churn rate");
  await searched(bob, 40, "  churn RATE ");
  await searched(alice, 30, "churn rate");
  await searched(bot, 20, "refund share");
  await searched(personBot, 21, "refund share");
  await searched(alice, 15, "order channel", ["column", "table", "column"]);
  await searched(bob, 14, "net sales", ["metric"], true);

  await asked(alice, 45, "answered", [], [{ kind: "metric", id: netSales }]);
  await asked(bob, 35, "not_answered", ["no_metric"], []);
  await asked(
    bot,
    25,
    "partly_answered",
    ["missing_description", "other"],
    [
      { kind: "measure", id: id.days },
      { kind: "metric", id: netSales },
    ],
  );

  await ran(alice, 55, "succeeded", ["Net sales"], { metric: netSales });
  const days = { dax: "EVALUATE {[Days in month]}" };
  await ran(bob, 44, "succeeded", ["Days in month"], {
    ...days,
    purpose: "days check",
  });
  await ran(alice, 33, "truncated", ["Days in month"], {
    ...days,
    purpose: "days again",
    id: daysAgain,
  });
  await ran(bot, 22, "failed", ["Net sales LY"], {});
  await ran(alice, 10, "refused", ["Net sales LY"], {});
  await logQuery(bob, {
    id: randomUUID(),
    at: ago(11),
    dataset: null,
    dax: "EVALUATE {1}",
    purpose: null,
    status: "refused",
    error: null,
    duration_ms: 1,
    measure_names: [],
    metric_ids: [],
  });
});

describe("usageReport", () => {
  it("counts searches, requests and queries over the period", async () => {
    const report = await usageReport(curator, { since });
    expect(report.since).toBe(since.toISOString());
    expect(report.until).toBe(now.toISOString());
    expect(report.totals).toEqual({
      searches: 7,
      searches_with_no_hits: 5,
      requests: 3,
      requests_by_outcome: {
        answered: 1,
        partly_answered: 1,
        not_answered: 1,
      },
      queries: 6,
      queries_without_metric: 2,
    });
    expect(report.hidden).toBe(0);
    expect(report.truncated_lists).toEqual([]);
  });

  it("groups searches by their trimmed lower-case text and counts people", async () => {
    const { not_covered } = await usageReport(curator, { since });
    expect(not_covered.searches_with_no_hits).toEqual([
      { query: "churn rate", count: 3, people: 2, last_at: iso(30) },
      { query: "refund share", count: 2, people: 2, last_at: iso(20) },
    ]);
    expect(not_covered.searches_without_metric).toEqual([
      {
        query: "order channel",
        count: 1,
        people: 1,
        last_at: iso(15),
        top_kinds: ["column", "table"],
      },
    ]);
  });

  it("lists requests short of answered, newest first", async () => {
    const { unanswered_requests } = (await usageReport(curator, { since }))
      .not_covered;
    expect(unanswered_requests).toMatchObject([
      {
        at: iso(25),
        principal: { kind: "service_account", id: "bot" },
        question: "Question from bot",
        outcome: "partly_answered",
        gaps: ["missing_description", "other"],
        missing: "No metric covers it.",
      },
      {
        at: iso(35),
        principal: { kind: "person", id: "bob" },
        question: "Question from bob",
        outcome: "not_answered",
        gaps: ["no_metric"],
        missing: "No metric covers it.",
      },
    ]);
  });

  it("groups queries that used no metric by dataset and DAX, with the latest", async () => {
    const report = await usageReport(curator, { since });
    expect(report.not_covered.queries_without_metric).toEqual([
      {
        dataset: salesRef,
        dax_hash: hash("EVALUATE {[Days in month]}"),
        count: 2,
        people: 2,
        last_at: iso(33),
        latest_query_id: daysAgain,
        latest_purpose: "days again",
      },
    ]);
  });

  it("lists measures no variant files and measures Power BI does not describe", async () => {
    const { badly_structured } = await usageReport(curator, { since });
    const ly = { dataset: salesRef, measure: "Net sales LY", count: 2 };
    const days = { dataset: salesRef, measure: "Days in month", count: 2 };
    expect(badly_structured.measures_without_metric).toEqual([
      { ...ly, people: 2, last_at: iso(10) },
      { ...days, people: 2, last_at: iso(33) },
    ]);
    expect(badly_structured.measures_without_description).toEqual([
      { ...ly, people: 2, last_at: iso(10), has_book_description: true },
      { ...days, people: 2, last_at: iso(33), has_book_description: false },
      {
        dataset: salesRef,
        measure: "Net sales",
        count: 1,
        people: 1,
        last_at: iso(55),
        has_book_description: false,
      },
    ]);
  });

  it("counts the gaps of each element requests name", async () => {
    const { flagged_elements } = (await usageReport(curator, { since }))
      .badly_structured;
    expect(flagged_elements).toEqual([
      {
        element: { kind: "metric", id: netSales, name: "net_sales" },
        gaps: { missing_description: 1, other: 1 },
        requests: 2,
      },
      {
        element: { kind: "measure", id: id.days, name: "Days in month" },
        gaps: { missing_description: 1, other: 1 },
        requests: 1,
      },
    ]);
  });

  it("lists unverified metrics in use and failed queries per dataset", async () => {
    const { badly_structured } = await usageReport(curator, { since });
    expect(badly_structured.used_unverified_metrics).toEqual([
      {
        metric: { key: "net_sales", label: "net_sales", trust_state: "draft" },
        count: 1,
        people: 1,
        last_at: iso(55),
      },
    ]);
    expect(badly_structured.failed_queries).toEqual([
      { dataset: salesRef, failed: 1, refused: 1, last_at: iso(10) },
    ]);
  });

  it("cuts each list to limit and names the lists it cut", async () => {
    const report = await usageReport(curator, { since, limit: 1 });
    expect(report.truncated_lists).toEqual([
      "searches_with_no_hits",
      "unanswered_requests",
      "measures_without_metric",
      "measures_without_description",
      "flagged_elements",
    ]);
    expect(report.not_covered.searches_with_no_hits).toHaveLength(1);
    expect(report.badly_structured.flagged_elements).toHaveLength(1);
  });

  it("narrows to one dataset", async () => {
    const report = await usageReport(curator, { since, dataset: "Sales" });
    expect(report.totals.queries).toBe(5);
    expect(report.totals.searches).toBe(0);
    expect(report.totals.requests).toBe(1);
    expect(
      report.badly_structured.flagged_elements.map((row) => row.element.id),
    ).toEqual([id.days]);
  });

  it("leaves catalog reads out of every total and list", async () => {
    const before = await usageReport(curator, { since });
    for (const status of [
      "succeeded",
      "truncated",
      "failed",
      "refused",
    ] as const) {
      await logQuery(alice, {
        id: randomUUID(),
        at: ago(1),
        dataset: sales,
        dax: "EVALUATE INFO.VIEW.MEASURES()",
        purpose: null,
        status,
        error: null,
        duration_ms: 1,
        measure_names: ["Days in month", "Net sales", "Net sales LY"],
        metric_ids: status === "succeeded" ? [netSales] : [],
        origin: "catalog",
      });
    }
    expect(await usageReport(curator, { since })).toEqual(before);
  });

  it("refuses since after until", async () => {
    await expect(
      usageReport(curator, { since: now, until: since }),
    ).rejects.toMatchObject({
      kind: "invalid",
      message: "since must be before until.",
    });
  });

  it("refuses a since past the retention and a limit out of range", async () => {
    const old = new Date(now.getTime() - 181 * 86_400_000);
    for (const input of [
      { since: old },
      { since, limit: 0 },
      { since, limit: 101 },
    ])
      await expect(usageReport(curator, input)).rejects.toMatchObject({
        kind: "invalid",
      });
  });
});
