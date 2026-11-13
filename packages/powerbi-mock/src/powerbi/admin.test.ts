import { describe, expect, it } from "vitest";
import {
  APP_ID,
  BEN,
  DATASET_ID,
  GIL,
  MEMBER_APP_ID,
  SCANNER_APP_ID,
  WORKSPACE_ID,
  pastLimit,
  startPowerBi,
} from "./test-support.js";

type List = { "@odata.context": string; value: Record<string, unknown>[] };

async function scannerCall(path: string) {
  const mock = startPowerBi();
  const token = await mock.principalToken(SCANNER_APP_ID);
  return { mock, token, response: await mock.call(path, token) };
}

describe("admin/apps", () => {
  it("lists the apps with their workspace and publisher", async () => {
    const { response } = await scannerCall("admin/apps?$top=10");
    expect(response.status).toBe(200);
    const list = (await response.json()) as List;
    expect(list["@odata.context"]).toBe(
      "http://mock.test/powerbi/v1.0/myorg/admin/$metadata#apps",
    );
    expect(list.value).toEqual([
      {
        id: APP_ID,
        name: "Sales app",
        description: "The sales report, published.",
        lastUpdate: "2026-10-01T00:00:00Z",
        publishedBy: "ada@example.test",
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });

  it("requires $top of 1 or more, takes $skip of 1 or more, and skips with it", async () => {
    const { mock, token } = await scannerCall("admin/apps?$top=1");
    for (const query of ["", "?$top=0", "?$top=5&$skip=0"]) {
      expect((await mock.call(`admin/apps${query}`, token)).status).toBe(400);
    }
    const skipped = await mock.call("admin/apps?$top=5&$skip=1", token);
    expect(((await skipped.json()) as List).value).toEqual([]);
  });

  it("answers 429 on the 201st call in an hour", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const { statuses, refused } = await pastLimit(200, () =>
      mock.call("admin/apps?$top=1", token),
    );
    expect(statuses).toEqual([200]);
    expect(refused.status).toBe(429);
  });
});

describe("admin/apps/{appId}/users", () => {
  it("lists the audience by Entra object id", async () => {
    const { response } = await scannerCall(`admin/apps/${APP_ID}/users`);
    const list = (await response.json()) as List;
    expect(list.value.map((user) => user.graphId)).toEqual([
      "cccccccc-0000-4000-8000-000000000001",
      BEN,
      GIL,
    ]);
    expect(list.value[1]).toEqual({
      displayName: "Ben",
      emailAddress: "ben@example.test",
      identifier: "ben@example.test",
      graphId: BEN,
      principalType: "User",
      appUserAccessRight: "ReadExplore",
    });
  });

  it("answers 404 for an app the tenant does not have", async () => {
    const { response } = await scannerCall(
      "admin/apps/bbbbbbbb-0000-4000-8000-0000000000ff/users",
    );
    expect(response.status).toBe(404);
  });
});

describe("admin/reports", () => {
  it("lists reports with their dataset, app and workspace", async () => {
    const { response } = await scannerCall("admin/reports");
    const list = (await response.json()) as List;
    expect(list.value).toEqual([
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        name: "Sales overview",
        reportType: "PowerBIReport",
        datasetId: DATASET_ID,
        appId: APP_ID,
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });

  it("pages with $top and $skip", async () => {
    const { mock, token } = await scannerCall("admin/reports");
    const page = await mock.call("admin/reports?$top=1&$skip=1", token);
    expect(((await page.json()) as List).value).toEqual([]);
  });

  it("filters by app with appId eq, and refuses a filter it cannot evaluate", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const ids = async (filter: string) => {
      const response = await mock.call(
        `admin/reports?$filter=${encodeURIComponent(filter)}`,
        token,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as List).value.map((r) => r.id);
    };
    expect(await ids(`appId eq '${APP_ID}'`)).toEqual([
      "eeeeeeee-0000-4000-8000-000000000001",
    ]);
    expect(
      await ids("appId eq 'bbbbbbbb-0000-4000-8000-0000000000ff'"),
    ).toEqual([]);
    const other = await mock.call(
      `admin/reports?$filter=${encodeURIComponent("appId ne null")}`,
      token,
    );
    expect(other.status).toBe(400);
  });

  it("answers 429 on the sixth call in a minute", async () => {
    const mock = startPowerBi();
    const token = await mock.principalToken(SCANNER_APP_ID);
    const { statuses, refused } = await pastLimit(5, () =>
      mock.call("admin/reports", token),
    );
    expect(statuses).toEqual([200]);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });
});

describe("admin/groups", () => {
  it("lists names and workspace types, and pages with $top and $skip", async () => {
    const { mock, token, response } = await scannerCall("admin/groups?$top=1");
    expect(response.status).toBe(200);
    expect(((await response.json()) as List).value).toEqual([
      { id: WORKSPACE_ID, name: "Sales", type: "Workspace", state: "Active" },
    ]);
    expect((await mock.call("admin/groups?$top=1", null)).status).toBe(401);
    const member = await mock.principalToken(MEMBER_APP_ID);
    expect((await mock.call("admin/groups?$top=1", member)).status).toBe(401);
    const page = await mock.call("admin/groups?$top=1&$skip=1", token);
    expect(((await page.json()) as List).value[0]?.type).toBe("PersonalGroup");
    for (const query of ["", "?$top=0", "?$top=5001", "?$top=1&$skip=-1"]) {
      expect((await mock.call(`admin/groups${query}`, token)).status).toBe(400);
    }
  });
});
