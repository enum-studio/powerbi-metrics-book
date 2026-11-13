import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ServiceContext } from "../../context.js";
import { piiRule } from "../../db/schema/pii.js";
import { request } from "../../db/schema/usage.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { cerbosAccess, createTestDeps } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { id, reaching, useMirror } from "../../../test/mirror-fixtures.js";
import { logQuery } from "../queries/log.js";
import { usageReport } from "./report.js";

/*
 * The report reads every person's searches, requests and queries, so it is
 * for curators and admins only, and it shows nothing of a dataset the curator
 * may not describe beyond a count. The curator here reaches the Sales
 * workspace under metadata_visibility powerbi, so Finance is hidden from them.
 */

useMirror();

const now = new Date(Date.UTC(2026, 10, 11, 12));
const access = cerbosAccess(
  new MemorySettings({ "access.metadata_visibility": "powerbi" }),
);
const as = (principal: Principal): ServiceContext => ({
  ...createTestDeps({ access, clock: () => now }),
  principal,
});
const curator = as(
  reaching({ powerbi_workspace_ids: [id.sales_workspace] }, "curator"),
);
const since = new Date(now.getTime() - 3_600_000);
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

describe("usageReport", () => {
  it("refuses a person without curator", async () => {
    const viewer = as(
      reaching({ powerbi_workspace_ids: [id.sales_workspace] }),
    );
    await expect(usageReport(viewer, { since })).rejects.toMatchObject({
      kind: "refused",
    });
  });

  it("refuses a service account without curator", async () => {
    const account = as({
      ...reaching({ powerbi_workspace_ids: [id.sales_workspace] }),
      kind: "service_account",
      id: "test-curator",
      roles: ["viewer"],
      via: "api",
    });
    await expect(usageReport(account, { since })).rejects.toMatchObject({
      kind: "refused",
    });
  });

  it("answers a dataset the curator may not describe like a missing one", async () => {
    for (const dataset of [id.finance, "Finance", randomUUID()])
      await expect(usageReport(curator, { since, dataset })).rejects.toThrow(
        new ServiceError("not_found", NO_SUCH_DATASET),
      );
  });

  it("counts an undescribable dataset's queries and request elements in hidden, and names none of it", async () => {
    const asker = as(reaching({}, "viewer"));
    const ran = (
      dataset: { id: string; name: string; workspace_id: string },
      measure: string,
      status: "succeeded" | "failed",
      at: Date,
    ) =>
      logQuery(asker, {
        id: randomUUID(),
        at,
        dataset,
        dax: `EVALUATE ROW("x", [${measure}])`,
        purpose: "monthly check",
        status,
        error: status === "failed" ? "The query failed." : null,
        duration_ms: 30,
        measure_names: [measure],
        metric_ids: [],
      });
    const finance = {
      id: id.finance,
      name: "Finance",
      workspace_id: id.finance_workspace,
    };
    const sales = {
      id: id.sales,
      name: "Sales",
      workspace_id: id.sales_workspace,
    };
    await ran(finance, "Profit", "succeeded", minutesAgo(30));
    await ran(finance, "Profit", "failed", minutesAgo(29));
    await ran(sales, "Net sales", "succeeded", minutesAgo(28));
    await asker.auditDb.insert(request).values({
      id: randomUUID(),
      at: minutesAgo(27),
      principal_kind: "person",
      principal_id: asker.principal.id,
      via: "mcp",
      question: "What does this number mean?",
      outcome: "not_answered",
      gaps: ["missing_description"],
      elements: [
        { kind: "dataset", id: id.finance },
        { kind: "measure", id: id.profit },
        { kind: "measure", id: id.net_sales },
      ],
    });

    const report = await usageReport(curator, { since });

    expect(report.hidden).toBe(4);
    expect(report.totals.queries).toBe(1);
    expect(report.badly_structured.flagged_elements).toEqual([
      {
        element: { kind: "measure", id: id.net_sales, name: "Net sales" },
        gaps: { missing_description: 1 },
        requests: 1,
      },
    ]);
    expect(report.badly_structured.failed_queries).toEqual([]);
    const text = JSON.stringify(report);
    for (const secret of [
      "Finance",
      "Profit",
      "Ledger",
      id.finance,
      id.profit,
      id.finance_workspace,
    ])
      expect(text).not.toContain(secret);
  });

  it("silently hides PII measures unless the curator is a pii_reader", async () => {
    await curator.db.insert(piiRule).values({
      kind: "measure",
      table_name: "Date",
      name: "Days in month",
      pii: true,
      set_by_kind: "person",
      set_by_id: "admin",
      set_via: "browser",
    });
    await logQuery(curator, {
      id: randomUUID(),
      at: minutesAgo(2),
      dataset: {
        id: id.sales,
        name: "Sales",
        workspace_id: id.sales_workspace,
      },
      dax: "EVALUATE {[Days in month]}",
      purpose: null,
      status: "succeeded",
      error: null,
      duration_ms: 1,
      measure_names: ["Days in month"],
      metric_ids: [],
    });
    await curator.auditDb.insert(request).values({
      id: randomUUID(),
      at: minutesAgo(2),
      principal_kind: "person",
      principal_id: curator.principal.id,
      via: "mcp",
      question: "What does this measure mean?",
      outcome: "not_answered",
      gaps: ["missing_description"],
      elements: [{ kind: "measure", id: id.days }],
    });
    const reader = as({
      ...curator.principal,
      roles: ["curator", "pii_reader"],
    });
    for (const caller of [curator, reader]) {
      const report = await usageReport(caller, { since: minutesAgo(5) });
      const measures = caller === reader ? ["Days in month"] : [];
      expect.soft(report.hidden).toBe(0);
      expect
        .soft(
          report.badly_structured.measures_without_description.map(
            (row) => row.measure,
          ),
        )
        .toEqual(measures);
      expect
        .soft(
          report.badly_structured.measures_without_metric.map(
            (row) => row.measure,
          ),
        )
        .toEqual(measures);
    }
  });
});
