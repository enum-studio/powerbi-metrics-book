import {
  sampleTenant,
  type MockPowerBiHandle,
} from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  find,
  samplePerson,
  startPowerBi,
} from "../../test/powerbi-support.js";
import { ServiceError } from "../errors.js";
import { appUsers, listApps, listReports, requestAdmin } from "./admin.js";
import type { PowerBiDeps } from "./identity.js";
import {
  mayBeOneWorkspace,
  mirrorSpelling,
  modifiedWorkspaces,
  scanResult,
  startScan,
  waitForScan,
} from "./scanner.js";

const tenant = sampleTenant();
const shared = tenant.workspaces
  .filter((w) => w.type !== "PersonalGroup")
  .map((w) => w.id);
const named = <T extends { name: string }>(items: T[], name: string) =>
  find(items, (item) => item.name === name);

let mock: MockPowerBiHandle;
let deps: PowerBiDeps;

beforeAll(async () => {
  ({ mock, deps } = await startPowerBi(tenant));
});

afterAll(() => mock.close());

describe("the scanner", () => {
  describe("whether one workspace may have spoiled a scan", () => {
    const answered = (text: string) =>
      scanResult(
        {
          ...deps,
          fetcher: {
            ...deps.fetcher,
            fetchFixed: (url, init) =>
              String(url).includes("/scanResult/")
                ? Promise.resolve(new Response(text))
                : deps.fetcher.fetchFixed(url, init),
          },
        },
        "a-scan",
      ).then(
        () => {
          throw new Error("the answer was read");
        },
        (error: unknown) => {
          if (error instanceof ServiceError) return error;
          throw error;
        },
      );

    it("says yes of a workspace this version cannot read", async () => {
      const error = await answered('{"workspaces":[{"id":"only an id"}]}');
      expect(mayBeOneWorkspace(error)).toBe(true);
    });

    it("says no of a gateway's page, which is no scan at all", async () => {
      expect(mayBeOneWorkspace(await answered("<html></html>"))).toBe(false);
      expect(mayBeOneWorkspace(await answered('{"value":[]}'))).toBe(false);
    });
  });

  it("waits as long as the fetcher allows for a scan's answer", async () => {
    const calls = vi.spyOn(deps.fetcher, "fetchFixed");
    const scanId = await startScan(deps, shared);
    await waitForScan(deps, scanId, { poll_ms: 10 });
    await scanResult(deps, scanId);
    const read = calls.mock.calls.find(([url]) =>
      String(url).includes("/scanResult/"),
    );
    expect(read?.[1]).toMatchObject({ timeout_ms: 300_000 });
    calls.mockRestore();
  });

  it("lists the workspaces that are not personal, with or without a moment to start from", async () => {
    expect(await modifiedWorkspaces(deps, { since: null })).toEqual(shared);
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    expect(await modifiedWorkspaces(deps, { since: hourAgo })).toEqual(shared);
  });

  it("waits for a scan through Running and reads its result without the mashup", async () => {
    const scanId = await startScan(deps, shared);
    await waitForScan(deps, scanId, { poll_ms: 10 });
    const result = await scanResult(deps, scanId);

    const mashup = /Sql\.Database|SampleServer|"source"|"expressions"/;
    const raw = await requestAdmin(deps, `/workspaces/scanResult/${scanId}`);
    expect(JSON.stringify(raw)).toMatch(mashup);
    expect(JSON.stringify(result)).not.toMatch(mashup);

    expect(result.workspaces.map((w) => w.id)).toEqual(shared);
    const sales = named(result.workspaces, "Sales");
    expect(sales.users).toContainEqual({
      principal_type: "group",
      principal_object_id: named(tenant.groups, "Analysts").object_id,
      email: null,
      access_right: "Member",
    });
    const datasets = result.workspaces.flatMap((w) => w.datasets ?? []);
    const tables = datasets.flatMap((d) => d.tables ?? []);
    const types = tables
      .flatMap((t) => t.columns ?? [])
      .map((c) => c.columnType);
    expect(new Set(types)).toEqual(
      new Set(["data", "calculated", "calculated_table_column"]),
    );
    const measures = named(datasets, "Sales").tables?.flatMap(
      (t) => t.measures ?? [],
    );
    expect(measures?.find((m) => m.name === "Net sales")?.expression).toMatch(
      /\S/,
    );
    expect(named(datasets, "Campaign archive").schemaRetrievalError).toMatch(
      /\S/,
    );
    // The diagram's large-model layout is checked against this one.
    expect(named(datasets, "Retail").tables).toHaveLength(16);
    // Enumerations come out as the mirror stores them.
    expect(sales).toMatchObject({ type: "workspace", state: "active" });
    expect(named(datasets, "Sales").targetStorageMode).toBe("import");
  });

  it("spells Power BI's enumerations the mirror's way", () => {
    const spelled = ["PersonalGroup", "DirectQuery", "BothDirections", "Data"];
    expect(spelled.map(mirrorSpelling)).toEqual([
      "personal_group",
      "direct_query",
      "both_directions",
      "data",
    ]);
  });

  it("waits out a 429 for its Retry-After and polls again", async () => {
    const scanId = await startScan(deps, shared.slice(0, 1));
    mock.failNext("/powerbi/v1.0/myorg/admin/workspaces/scanStatus", 429, 1);
    const started = Date.now();

    await waitForScan(deps, scanId, { poll_ms: 10 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });
});

describe("what the real scanner sends as null", () => {
  it("reads a null access list as no list and a null email as none", async () => {
    const own = sampleTenant();
    const unlisted = find(own.workspaces, (w) => w.name === "Sales");
    unlisted.users_unlisted = true;
    const fixture = await startPowerBi(own);
    try {
      const raw = async (id: string) => {
        const scanId = await startScan(fixture.deps, [id]);
        await waitForScan(fixture.deps, scanId, { poll_ms: 10 });
        return {
          raw: await requestAdmin(
            fixture.deps,
            `/workspaces/scanResult/${scanId}`,
          ),
          result: await scanResult(fixture.deps, scanId),
        };
      };
      const sales = await raw(unlisted.id);
      expect(JSON.stringify(sales.raw)).toContain('"users":null');
      expect(sales.result.workspaces[0]?.users).toBeUndefined();

      const marketing = await raw(named(own.workspaces, "Marketing").id);
      expect(JSON.stringify(marketing.raw)).toContain('"emailAddress":null');
      expect(JSON.stringify(marketing.raw)).toContain('"userType":null');
      expect(marketing.result.workspaces[0]?.users).toContainEqual({
        principal_type: "app",
        principal_object_id: expect.any(String) as string,
        email: null,
        access_right: "Member",
      });
    } finally {
      await fixture.mock.close();
    }
  });
});

describe("a dataset the scanner answers with users: null", () => {
  it("comes out with no list, the same as a missing key", async () => {
    const own = sampleTenant();
    const fixture = await startPowerBi(own);
    try {
      const real = fixture.deps.fetcher;
      const nulled = {
        ...fixture.deps,
        fetcher: {
          ...real,
          fetchFixed: async (
            url: URL | string,
            init?: Parameters<typeof real.fetchFixed>[1],
          ) => {
            const response = await real.fetchFixed(url, init);
            if (!String(url).includes("/workspaces/scanResult/"))
              return response;
            const body = (await response.json()) as {
              workspaces: { datasets?: { users?: unknown }[] }[];
            };
            for (const workspace of body.workspaces)
              for (const dataset of workspace.datasets ?? [])
                dataset.users = null;
            return Response.json(body);
          },
        },
      };
      const scanId = await startScan(nulled, [
        named(own.workspaces, "Sales").id,
      ]);
      await waitForScan(nulled, scanId, { poll_ms: 10 });
      const datasets = (await scanResult(nulled, scanId)).workspaces.flatMap(
        (workspace) => workspace.datasets ?? [],
      );
      expect(datasets.length).toBeGreaterThan(0);
      for (const dataset of datasets) expect(dataset.users).toBeUndefined();
    } finally {
      await fixture.mock.close();
    }
  });
});

describe("apps and reports", () => {
  it("reads every app across pages", async () => {
    const apps = await listApps(deps, { page_size: 1 });
    expect(apps.map((a) => a.id)).toEqual(tenant.apps.map((a) => a.id));
  });

  it("reads an app's audience as the mirror stores it", async () => {
    const users = await appUsers(deps, named(tenant.apps, "Sales app").id);
    expect(users).toContainEqual({
      principal_type: "user",
      principal_object_id: samplePerson(tenant, "viewer").object_id,
      email: "viewer@sample.example",
      access_right: "ReadExplore",
    });
  });

  it("reads reports across pages, or one app's", async () => {
    const all = await listReports(deps, { page_size: 2 });
    expect(all.map((r) => r.id)).toEqual(tenant.reports.map((r) => r.id));

    const app = named(tenant.apps, "Sales app").id;
    const reports = await listReports(deps, { app_id: app });
    expect(reports.map((r) => r.appId)).toEqual([app, app]);
  });
});
