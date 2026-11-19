import { describe, expect, it } from "vitest";
import {
  EXPECTED_CYCLE,
  EXPECTED_DISMISSED,
  EXPECTED_DRAFTS,
  EXPECTED_NOT_GROUPED,
  EXPECTED_QUERY_ACCESS,
  EXPECTED_READS_SELECTION,
  EXPECTED_VISIBILITY,
  type SampleMeasure,
} from "./expected.js";
import { startPowerBi } from "../powerbi/test-support.js";
import { SAMPLE_IDS, SAMPLE_TENANT_ID, sampleTenant } from "./tenant.js";

const tenant = sampleTenant();
const key = ({ dataset, measure }: SampleMeasure) => `${dataset} / ${measure}`;
const tenantMeasures = tenant.datasets.flatMap((dataset) =>
  dataset.tables.flatMap((table) =>
    table.measures.map((m) => key({ dataset: dataset.name, measure: m.name })),
  ),
);
const datasetNames = tenant.datasets.map((d) => d.name);

describe("the sample tenant", () => {
  it("holds every measure EXPECTED_DRAFTS names, in the dataset it names", () => {
    const named = EXPECTED_DRAFTS.flatMap((d) => [...d.base, ...d.variants]);
    expect(named.map(key).filter((m) => !tenantMeasures.includes(m))).toEqual(
      [],
    );
    for (const variant of EXPECTED_DRAFTS.flatMap((d) => d.variants)) {
      expect(tenantMeasures).toContain(
        key({ dataset: variant.dataset, measure: variant.of }),
      );
    }
  });

  it("holds every other measure the expectations name", () => {
    const named = [
      ...EXPECTED_NOT_GROUPED.flatMap((pair) => pair.measures),
      ...EXPECTED_READS_SELECTION,
      ...EXPECTED_DISMISSED,
      ...EXPECTED_CYCLE.measures.map((measure) => ({
        dataset: EXPECTED_CYCLE.dataset,
        measure,
      })),
    ];
    expect(named.map(key).filter((m) => !tenantMeasures.includes(m))).toEqual(
      [],
    );
  });

  it("has an expectation for every measure, exactly once", () => {
    const accounted = [
      ...EXPECTED_DRAFTS.flatMap((d) => [...d.base, ...d.variants]),
      ...EXPECTED_DISMISSED,
      ...EXPECTED_CYCLE.measures.map((measure) => ({
        dataset: EXPECTED_CYCLE.dataset,
        measure,
      })),
    ].map(key);
    expect(accounted.toSorted()).toEqual(tenantMeasures.toSorted());
  });

  it("holds every person and dataset the access expectations name", () => {
    const emails = tenant.people.map((p) => p.email);
    const principals = [
      ...emails,
      ...tenant.service_principals.map((sp) => sp.app_id),
    ];
    expect(Object.keys(EXPECTED_VISIBILITY).toSorted()).toEqual(
      emails.toSorted(),
    );
    expect(
      Object.keys(EXPECTED_QUERY_ACCESS).filter((p) => !principals.includes(p)),
    ).toEqual([]);
    const datasets = [
      ...Object.values(EXPECTED_VISIBILITY).flat(),
      ...Object.values(EXPECTED_QUERY_ACCESS).flatMap((byDataset) =>
        Object.keys(byDataset),
      ),
    ];
    expect(datasets.filter((d) => !datasetNames.includes(d))).toEqual([]);
  });

  it("is the same on every call", () => {
    expect(JSON.stringify(sampleTenant())).toEqual(JSON.stringify(tenant));
    expect(tenant.tenant_id).toBe(SAMPLE_TENANT_ID);
  });

  it("registers the api's two callbacks under the base URL it is built for", () => {
    const uris = (t: typeof tenant) =>
      t.apps_registrations.flatMap((r) => r.redirect_uris);
    expect(uris(tenant)).toEqual([
      "http://localhost:3000/api/auth/callback/microsoft",
      "http://localhost:3000/api/v1/powerbi/callback",
    ]);
    const base = "http://localhost:41234";
    expect(uris(sampleTenant({ public_base_url: base }))).toEqual([
      `${base}/api/auth/callback/microsoft`,
      `${base}/api/v1/powerbi/callback`,
    ]);
  });

  it("labels the tenant as sample data, not its names", () => {
    const names = [
      ...tenant.people.map((p) => p.name),
      ...tenant.groups.map((g) => g.name),
      ...tenant.workspaces.map((w) => w.name),
      ...tenant.apps.map((a) => a.name),
      ...tenant.reports.map((r) => r.name),
      ...datasetNames,
    ];
    expect(names.filter((name) => name.startsWith("Sample data"))).toEqual([]);
    expect(
      tenant.people.filter((p) => !p.email.endsWith("@sample.example")),
    ).toEqual([]);
  });

  it("has a few thousand sales rows to page through", () => {
    const sales = tenant.datasets
      .find((d) => d.name === "Sales")
      ?.tables.find((t) => t.name === "Sales lines");
    expect(sales?.rows.length).toBeGreaterThan(2000);
  });

  it("gives a workspace, its datasets and their tables names of their own", () => {
    const repeated = tenant.datasets.flatMap((d) => {
      const workspace = tenant.workspaces.find((w) => w.id === d.workspace_id);
      const path = [workspace?.name, d.name, ...d.tables.map((t) => t.name)];
      return path.filter((name, i) => path.indexOf(name) !== i);
    });
    expect(repeated).toEqual([]);
  });

  it("gives one dataset each odd property the README lists", () => {
    const having = (has: (d: (typeof tenant.datasets)[number]) => unknown) =>
      tenant.datasets.filter(has).map((d) => d.name);
    expect(having((d) => d.has_row_level_security)).toEqual([
      "Finance",
      "Retail",
    ]);
    expect(having((d) => d.refuses_info_views)).toEqual(["Marketing"]);
    expect(having((d) => d.schema_retrieval_error)).toEqual([
      "Campaign archive",
    ]);
    const tables = tenant.datasets.flatMap((d) => d.tables);
    expect(
      tables.filter((t) => t.source_expression).map((t) => t.name),
    ).toContain("Date");
    const calculated = tables.flatMap((t) =>
      t.columns.filter((c) => c.expression),
    );
    expect(calculated.map((c) => c.name)).toEqual(["Bounce rate"]);
  });

  it("fills every column of every row", () => {
    for (const t of tenant.datasets.flatMap((d) => d.tables)) {
      const columns = t.columns.map((c) => c.name).toSorted();
      const odd = t.rows.filter(
        (row) => Object.keys(row).toSorted().join() !== columns.join(),
      );
      expect(odd, t.name).toEqual([]);
    }
  });
});

describe("the Retail sample dataset", () => {
  const retail = tenant.datasets.find((d) => d.name === "Retail");
  const mock = startPowerBi(tenant);
  const answer = async (dax: string) => {
    const token = await mock.personToken(SAMPLE_IDS.people.admin);
    const response = await mock.call(
      `datasets/${SAMPLE_IDS.datasets.retail}/executeQueries`,
      token,
      {
        body: { queries: [{ query: dax }] },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: { tables: { rows: Record<string, unknown>[] }[] }[];
    };
    return body.results[0]?.tables[0]?.rows ?? [];
  };

  it("is a large model: 16 tables and 20 relationships, in the Commercial workspace", () => {
    expect(retail?.tables).toHaveLength(16);
    expect(retail?.relationships).toHaveLength(20);
    expect(retail?.workspace_id).toBe(SAMPLE_IDS.workspaces.sales);
  });

  it("joins only tables and columns it holds", () => {
    const columnsOf = (name: string) =>
      retail?.tables.find((t) => t.name === name)?.columns.map((c) => c.name);
    const ends = (retail?.relationships ?? []).flatMap((r) => [
      [r.from_table, r.from_column],
      [r.to_table, r.to_column],
    ]);
    expect(
      ends.filter(([t, c]) => !columnsOf(t ?? "")?.includes(c ?? "")),
    ).toEqual([]);
  });

  it("answers INFO.VIEW.RELATIONSHIPS() with all 20", async () => {
    expect(await answer("EVALUATE INFO.VIEW.RELATIONSHIPS()")).toHaveLength(20);
  });

  it("answers a query of [Net sales]", async () => {
    const rows = await answer('EVALUATE ROW("Net sales", [Net sales])');
    const lines = retail?.tables.find((t) => t.name === "Order lines")?.rows;
    const net = (lines ?? []).reduce(
      (sum, r) => sum + Number(r["Net amount"]),
      0,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.["[Net sales]"])).toBeCloseTo(net, 2);
    expect(net).toBeGreaterThan(0);
  });
});
