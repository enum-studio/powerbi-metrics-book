import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADA,
  APP_ID,
  BROKEN_DATASET_ID,
  DATASET_ID,
  DELETED_WORKSPACE_ID,
  FAY,
  MEMBER_APP_ID,
  PERSONAL_WORKSPACE_ID,
  SCANNER_APP_ID,
  WORKSPACE_ID,
  pastLimit,
  powerBiTenant,
  startPowerBi,
  table,
} from "./test-support.js";

type Mock = ReturnType<typeof startPowerBi>;
type Info = Record<string, unknown> & {
  workspaces: {
    id: string;
    users?: Record<string, unknown>[];
    reports: Record<string, unknown>[];
    datasets: {
      id: string;
      users?: Record<string, unknown>[];
      expressions?: { name: string }[];
      relationships?: unknown[];
      schemaRetrievalError?: string;
      tables?: {
        name: string;
        source?: { expression: string }[];
        columns?: { name: string; columnType: string; expression?: string }[];
        measures?: Record<string, unknown>[];
      }[];
    }[];
  }[];
};

afterEach(() => {
  vi.useRealTimers();
});

const ALL_FLAGS =
  "datasetSchema=true&datasetExpressions=true&getArtifactUsers=true";

function startScan(
  mock: Mock,
  token: string,
  flags = ALL_FLAGS,
  ids = [WORKSPACE_ID],
) {
  return mock.call(`admin/workspaces/getInfo?${flags}`, token, {
    body: { workspaces: ids },
  });
}

/** Scans, polls until it succeeds and reads the result, as the sync does. */
async function scan(mock: Mock, flags = ALL_FLAGS): Promise<Info> {
  const token = await mock.principalToken(SCANNER_APP_ID);
  const { id } = (await (await startScan(mock, token, flags)).json()) as {
    id: string;
  };
  await mock.call(`admin/workspaces/scanStatus/${id}`, token);
  await mock.call(`admin/workspaces/scanStatus/${id}`, token);
  const result = await mock.call(`admin/workspaces/scanResult/${id}`, token);
  expect(result.status).toBe(200);
  return (await result.json()) as Info;
}

async function datasetOf(mock: Mock, flags = ALL_FLAGS) {
  const info = await scan(mock, flags);
  const dataset = info.workspaces[0]?.datasets.find((d) => d.id === DATASET_ID);
  if (!dataset) throw new Error("the scan has no sales dataset");
  return dataset;
}

describe("who may call the admin APIs", () => {
  it("refuses a person, a missing token, a principal the tenant did not allow and a tenant that switched the setting off", async () => {
    const mock = startPowerBi();
    const path = "admin/workspaces/modified";
    const refused = async (token: string | null) => {
      const response = await mock.call(path, token);
      return [response.status, await response.text()] as const;
    };

    expect((await refused(null))[0]).toBe(401);
    expect((await refused(await mock.personToken(ADA)))[0]).toBe(401);
    const [status, body] = await refused(
      await mock.principalToken(MEMBER_APP_ID),
    );
    expect(status).toBe(401);
    expect(body).toContain("API is not accessible for application");

    const scanner = await mock.principalToken(SCANNER_APP_ID);
    expect((await mock.call(path, scanner)).status).toBe(200);
    await mock.patchSettings({ service_principals_admin_apis: false });
    expect((await mock.call(path, scanner)).status).toBe(401);
  });

  it("lets a principal in once the control route allows it", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(MEMBER_APP_ID);
    await mock.patchSettings({
      service_principal: { app_id: MEMBER_APP_ID, may_call_admin_apis: true },
    });
    expect((await mock.call("admin/workspaces/modified", token)).status).toBe(
      200,
    );
  });
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function ago(offset_ms: number): string {
  return new Date(Date.now() - offset_ms)
    .toISOString()
    .replace(/\.\d+Z$/, ".0000000Z");
}

describe("modified", () => {
  async function modifiedIds(mock: Mock, query: string) {
    const token = await mock.principalToken(SCANNER_APP_ID);
    const response = await mock.call(
      `admin/workspaces/modified${query}`,
      token,
    );
    expect(response.status).toBe(200);
    const list = (await response.json()) as { id: string }[];
    return list.map((workspace) => workspace.id);
  }

  it("lists every workspace, leaves out personal ones on request, and ignores excludeInActiveWorkspaces", async () => {
    const mock = startPowerBi();
    expect(await modifiedIds(mock, "")).toEqual([
      WORKSPACE_ID,
      PERSONAL_WORKSPACE_ID,
      DELETED_WORKSPACE_ID,
    ]);
    expect(
      await modifiedIds(
        mock,
        "?excludePersonalWorkspaces=true&excludeInActiveWorkspaces=true",
      ),
    ).toEqual([WORKSPACE_ID, DELETED_WORKSPACE_ID]);
  });

  it("lists only the workspaces modified after modifiedSince, a workspace without a time counting as modified now", async () => {
    const tenant = powerBiTenant();
    const personal = tenant.workspaces.find(
      (w) => w.id === PERSONAL_WORKSPACE_ID,
    );
    if (!personal) throw new Error("no personal workspace");
    personal.modified_at = ago(10 * DAY_MS);
    const mock = startPowerBi(tenant);
    expect(
      await modifiedIds(mock, `?modifiedSince=${ago(5 * DAY_MS)}`),
    ).toEqual([WORKSPACE_ID, DELETED_WORKSPACE_ID]);
    expect(
      await modifiedIds(mock, `?modifiedSince=${ago(20 * DAY_MS)}`),
    ).toContain(PERSONAL_WORKSPACE_ID);
  });

  it("accepts modifiedSince between 30 minutes and 30 days old, with seven fractional digits and Z, and refuses the rest", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const status = async (since: string) =>
      (
        await mock.call(
          `admin/workspaces/modified?modifiedSince=${encodeURIComponent(since)}`,
          token,
        )
      ).status;
    const day_old = ago(DAY_MS);

    expect(await status(ago(31 * MINUTE_MS))).toBe(200);
    expect(await status(ago(29 * MINUTE_MS))).toBe(400);
    expect(await status(ago(29 * DAY_MS))).toBe(200);
    expect(await status(ago(31 * DAY_MS))).toBe(400);
    for (const malformed of [
      "soon",
      day_old.replace(/\.\d+Z$/, ".123Z"),
      day_old.replace(/\.\d+Z$/, "Z"),
      day_old.replace("Z", "+00:00"),
      day_old.replace("Z", ""),
      day_old.slice(0, 10),
    ]) {
      expect(await status(malformed)).toBe(400);
    }
  });

  it("answers 429 with Retry-After on the 31st call in an hour", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const { statuses, refused } = await pastLimit(30, () =>
      mock.call("admin/workspaces/modified", token),
    );
    expect(statuses).toEqual([200]);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3500);
  });
});

describe("getInfo, scanStatus and scanResult", () => {
  it("accepts a scan, reports it running on the first poll and succeeded after", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const started = await startScan(mock, token);
    expect(started.status).toBe(202);
    const { id, status } = (await started.json()) as {
      id: string;
      status: string;
    };
    expect(status).toBe("NotStarted");

    const early = await mock.call(`admin/workspaces/scanResult/${id}`, token);
    expect(early.status).toBe(400);
    const statuses = [];
    for (let poll = 0; poll < 3; poll += 1) {
      const answer = await mock.call(
        `admin/workspaces/scanStatus/${id}`,
        token,
      );
      statuses.push(((await answer.json()) as { status: string }).status);
    }
    expect(statuses).toEqual(["Running", "Succeeded", "Succeeded"]);
  });

  it("answers Failed with an error for a scan holding a workspace that fails, frees its place, and keeps its result back", async () => {
    const tenant = powerBiTenant();
    const workspace = tenant.workspaces.find((w) => w.id === WORKSPACE_ID);
    if (!workspace) throw new Error("the tenant has no sales workspace");
    workspace.scan_failure = "The scan could not read this workspace";
    const mock = startPowerBi(tenant);
    const token = await mock.principalToken(SCANNER_APP_ID);
    const started = await startScan(mock, token);
    const { id } = (await started.json()) as { id: string };
    const path = `admin/workspaces/scanStatus/${id}`;
    await mock.call(path, token);
    const answer = await mock.call(path, token);
    expect(await answer.json()).toMatchObject({
      status: "Failed",
      error: { message: "The scan could not read this workspace" },
    });
    const result = await mock.call(`admin/workspaces/scanResult/${id}`, token);
    expect(result.status).toBe(400);
    for (let n = 0; n < 16; n += 1)
      expect((await startScan(mock, token)).status).toBe(202);
  });

  it("answers 404 for a scan nobody started", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const unknown = "eeeeeeee-0000-4000-8000-0000000000ff";
    expect(
      (await mock.call(`admin/workspaces/scanStatus/${unknown}`, token)).status,
    ).toBe(404);
    expect(
      (await mock.call(`admin/workspaces/scanResult/${unknown}`, token)).status,
    ).toBe(404);
  });

  it("keeps a result for 24 hours of mock time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mock = startPowerBi();
    const first = await mock.principalToken(SCANNER_APP_ID);
    const { id } = (await (await startScan(mock, first)).json()) as {
      id: string;
    };
    await mock.call(`admin/workspaces/scanStatus/${id}`, first);
    await mock.call(`admin/workspaces/scanStatus/${id}`, first);

    vi.setSystemTime(Date.now() + 23 * 3_600_000);
    const later = await mock.principalToken(SCANNER_APP_ID);
    expect(
      (await mock.call(`admin/workspaces/scanResult/${id}`, later)).status,
    ).toBe(200);

    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    const gone = await mock.principalToken(SCANNER_APP_ID);
    expect(
      (await mock.call(`admin/workspaces/scanResult/${id}`, gone)).status,
    ).toBe(404);
    expect(
      (await mock.call(`admin/workspaces/scanStatus/${id}`, gone)).status,
    ).toBe(404);
  });

  it("takes 1 to 100 workspace ids", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
    expect((await startScan(mock, token, ALL_FLAGS, [])).status).toBe(400);
    expect((await startScan(mock, token, ALL_FLAGS, ids(101))).status).toBe(
      400,
    );
    expect((await startScan(mock, token, ALL_FLAGS, ids(100))).status).toBe(
      202,
    );
  });

  it("refuses a 17th scan while 16 are still running", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    for (let count = 0; count < 16; count += 1) {
      expect((await startScan(mock, token)).status).toBe(202);
    }
    const refused = await startScan(mock, token);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
  });

  it("forgets its scans and call counts when the control route resets the tenant", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const { id } = (await (await startScan(mock, token)).json()) as {
      id: string;
    };
    for (let call = 0; call < 30; call += 1) {
      await mock.call("admin/workspaces/modified", token);
    }

    const reset = await mock.app.request("http://mock.test/_mock/reset", {
      method: "POST",
    });
    expect(reset.status).toBe(204);
    const status = await mock.call(`admin/workspaces/scanStatus/${id}`, token);
    expect(status.status).toBe(404);
    expect((await mock.call("admin/workspaces/modified", token)).status).toBe(
      200,
    );
  });
});

describe("what a scan returns", () => {
  it("carries the model, the reports' app and dataset, and the mashup", async () => {
    const mock = startPowerBi();
    const info = await scan(mock);
    const [workspace] = info.workspaces;

    expect(workspace?.reports).toEqual([
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        name: "Sales overview",
        reportType: "PowerBIReport",
        datasetId: DATASET_ID,
        appId: APP_ID,
      },
    ]);
    const dataset = workspace?.datasets.find((d) => d.id === DATASET_ID);
    const orders = dataset?.tables?.find((t) => t.name === "Orders");
    expect(orders?.columns?.[0]).toEqual({
      name: "OrderId",
      dataType: "Int64",
      isHidden: false,
      columnType: "Data",
    });
    expect(orders?.measures).toEqual([
      {
        name: "Total sales",
        formatString: "#,0",
        isHidden: false,
        expression: "SUM(Orders[Amount])",
      },
    ]);
    expect(orders?.source?.[0]?.expression).toContain("Sql.Database");
    expect(dataset?.expressions?.[0]?.name).toBe("SampleServer");
    expect(dataset?.relationships).toEqual([]);
  });

  it("types data, RowNumber, calculated and calculated-table columns, with a calculated column's DAX only when expressions are allowed", async () => {
    const tenant = powerBiTenant();
    const [sales] = tenant.datasets;
    const [orders] = sales?.tables ?? [];
    if (!sales || !orders) throw new Error("no orders table");
    orders.columns.push({
      name: "Margin",
      data_type: "Double",
      description: null,
      hidden: false,
      expression: "Orders[Amount] * 0.2",
    });
    sales.tables.push({
      ...table("Dates", ["Date"], 1),
      source_expression: "CALENDARAUTO()",
    });
    const mock = startPowerBi(tenant);
    const columns = (dataset: Awaited<ReturnType<typeof datasetOf>>) =>
      dataset.tables?.flatMap((t) => t.columns ?? []) ?? [];

    const types = Object.fromEntries(
      columns(await datasetOf(mock)).map((c) => [c.name, c.columnType]),
    );
    expect(types).toEqual({
      OrderId: "Data",
      Amount: "Data",
      "RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61": "RowNumber",
      Margin: "Calculated",
      CustomerId: "Data",
      Date: "CalculatedTableColumn",
    });
    const margin = (dataset: Awaited<ReturnType<typeof datasetOf>>) =>
      columns(dataset).find((c) => c.name === "Margin");
    expect(margin(await datasetOf(mock))).toHaveProperty(
      "expression",
      "Orders[Amount] * 0.2",
    );
    expect(
      margin(await datasetOf(mock, "datasetSchema=true")),
    ).not.toHaveProperty("expression");
    await mock.patchSettings({ dax_expressions: false });
    expect(margin(await datasetOf(mock))).not.toHaveProperty("expression");
  });

  it("has no tables without datasetSchema", async () => {
    const mock = startPowerBi();
    const dataset = await datasetOf(mock, "getArtifactUsers=true");
    expect(dataset).not.toHaveProperty("tables");
    expect(dataset).not.toHaveProperty("expressions");
  });

  it("has tables without columns and measures when detailed metadata is off", async () => {
    const mock = startPowerBi();
    await mock.patchSettings({ detailed_metadata: false });
    const dataset = await datasetOf(mock);
    expect(dataset.tables?.map((t) => t.name)).toEqual(["Orders", "Customers"]);
    for (const table of dataset.tables ?? []) {
      expect(table).not.toHaveProperty("columns");
      expect(table).not.toHaveProperty("measures");
    }
  });

  it("has measures without expressions, and no mashup, when the DAX setting is off", async () => {
    const mock = startPowerBi();
    await mock.patchSettings({ dax_expressions: false });
    const dataset = await datasetOf(mock);
    const orders = dataset.tables?.find((t) => t.name === "Orders");
    expect(orders?.measures?.[0]).toMatchObject({ name: "Total sales" });
    expect(orders?.measures?.[0]).not.toHaveProperty("expression");
    expect(orders).not.toHaveProperty("source");
    expect(dataset).not.toHaveProperty("expressions");
  });

  it("has no expressions without datasetExpressions, even when the tenant allows them", async () => {
    const mock = startPowerBi();
    const dataset = await datasetOf(mock, "datasetSchema=true");
    const orders = dataset.tables?.find((t) => t.name === "Orders");
    expect(orders?.measures?.[0]).not.toHaveProperty("expression");
    expect(dataset).not.toHaveProperty("expressions");
  });

  it("lists the access lists only with getArtifactUsers", async () => {
    const mock = startPowerBi();
    const without = await scan(mock, "datasetSchema=true");
    expect(without.workspaces[0]).not.toHaveProperty("users");

    const info = await scan(mock);
    expect(info.workspaces[0]?.users).toEqual([
      {
        displayName: "Analysts",
        emailAddress: null,
        userType: null,
        identifier: "99999999-0000-4000-8000-000000000001",
        graphId: "99999999-0000-4000-8000-000000000001",
        principalType: "Group",
        groupUserAccessRight: "Contributor",
      },
      {
        displayName: "Fay",
        emailAddress: "fay@example.test",
        identifier: "fay@example.test",
        graphId: FAY,
        principalType: "User",
        groupUserAccessRight: "Viewer",
      },
      {
        displayName: "77777777-0000-4000-8000-0000000000a2",
        emailAddress: null,
        userType: null,
        identifier: "77777777-0000-4000-8000-0000000000a2",
        graphId: "77777777-0000-4000-8000-0000000000a2",
        principalType: "App",
        groupUserAccessRight: "Member",
      },
    ]);
    const sales = info.workspaces[0]?.datasets.find((d) => d.id === DATASET_ID);
    expect(sales?.users?.[0]).toEqual({
      displayName: "Dan",
      emailAddress: "dan@example.test",
      identifier: "dan@example.test",
      graphId: "cccccccc-0000-4000-8000-000000000005",
      principalType: "User",
      datasetUserAccessRight: "ReadExplore",
    });
    expect(sales?.users?.map((u) => u.datasetUserAccessRight)).toEqual([
      "ReadExplore",
      "Read",
    ]);
  });

  it("answers users: null for a workspace whose list Power BI does not give, as the real scanner does", async () => {
    const tenant = powerBiTenant();
    const personal = tenant.workspaces.find(
      (w) => w.id === PERSONAL_WORKSPACE_ID,
    );
    if (!personal) throw new Error("no personal workspace");
    personal.users_unlisted = true;
    const mock = startPowerBi(tenant);
    const token = await mock.principalToken(SCANNER_APP_ID);
    const { id } = (await (
      await startScan(mock, token, ALL_FLAGS, [
        WORKSPACE_ID,
        PERSONAL_WORKSPACE_ID,
      ])
    ).json()) as { id: string };
    await mock.call(`admin/workspaces/scanStatus/${id}`, token);
    await mock.call(`admin/workspaces/scanStatus/${id}`, token);
    const info = (await (
      await mock.call(`admin/workspaces/scanResult/${id}`, token)
    ).json()) as Info;
    const byId = (workspace: string) =>
      info.workspaces.find((w) => w.id === workspace);
    expect(byId(PERSONAL_WORKSPACE_ID)).toHaveProperty("users", null);
    expect(byId(WORKSPACE_ID)?.users).toBeInstanceOf(Array);
  });

  it("returns a dataset's schema error without tables", async () => {
    const mock = startPowerBi();
    const info = await scan(mock);
    const broken = info.workspaces[0]?.datasets.find(
      (d) => d.id === BROKEN_DATASET_ID,
    );
    expect(broken?.schemaRetrievalError).toBe(
      "The model has never been refreshed.",
    );
    expect(broken).not.toHaveProperty("tables");
  });
});
