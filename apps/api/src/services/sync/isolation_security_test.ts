import { randomBytes, randomUUID } from "node:crypto";
import {
  type MockPowerBiHandle,
  sampleTenant,
  type Tenant,
} from "@powerbi-metrics-book/powerbi-mock";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, type MockInstance, vi } from "vitest";
import { z } from "zod";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { find, startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { AppDeps, Db } from "../../context.js";
import { metricVariant } from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import { jobRequest } from "../../db/schema/jobs.js";
import {
  powerbiAccess,
  powerbiApp,
  powerbiDataset,
  powerbiMeasure,
  powerbiWorkspace,
  syncRun,
} from "../../db/schema/mirror.js";
import { runSync, type SyncKind } from "./run.js";

/*
 * Anyone who can publish a Power BI model writes what the worker reads. A
 * workspace or dataset that cannot be scanned or stored may cost itself and
 * nothing else: the others stay mirrored, and the run says which one failed.
 *
 * A NUL and a name of 5,000 characters stand for any value Postgres refuses.
 * Microsoft's rules keep both out of a real model's names
 * (docs/decisions/powerbi.md): the guard does not depend on which value it is.
 */

afterAll(closeTestPools);

const SCAN_LIMIT_BYTES = 32 * 1024 * 1024;

type Scanned = Tenant["datasets"][number]["tables"][number]["measures"][number];

async function withSync(
  tenant: Tenant,
  work: (
    tx: Db,
    sync: () => Promise<unknown>,
    deps: AppDeps,
    mock: MockPowerBiHandle,
  ) => Promise<void>,
): Promise<void> {
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const deps = createTestDeps({ ...powerbi, container: "worker", db: tx });
      await work(
        tx,
        () => runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 }),
        deps,
        mock,
      );
    });
  } finally {
    await mock.close();
  }
}

const lastRun = async (tx: Db) => {
  const [run] = await tx
    .select()
    .from(syncRun)
    .orderBy(desc(syncRun.started_at))
    .limit(1);
  if (run === undefined) throw new Error("no sync run");
  return run;
};

const workspaceNamed = (tenant: Tenant, name: string) =>
  find(tenant.workspaces, (w) => w.name === name);
const datasetNamed = (tenant: Tenant, name: string) =>
  find(tenant.datasets, (d) => d.name === name);

function addMeasure(
  tenant: Tenant,
  datasetName: string,
  measure: Partial<Scanned> & { name: string },
): Scanned {
  const table = datasetNamed(tenant, datasetName).tables.find(
    (t) => t.measures.length > 0,
  );
  const model = table?.measures[0];
  if (table === undefined || model === undefined)
    throw new Error("The dataset has no measure to copy");
  const added = { ...model, ...measure };
  table.measures.push(added);
  return added;
}

/** Empty workspaces, so a batch holds the sample's three and these. */
function addFillers(tenant: Tenant, count: number): string[] {
  const fillers = Array.from({ length: count }, (_, n) => ({
    id: randomUUID(),
    type: "Workspace",
    state: "Active",
    name: `Filler ${String(n)}`,
    users: [],
    dataset_ids: [],
    report_ids: [],
  }));
  tenant.workspaces.push(...fillers);
  return fillers.map((filler) => filler.id);
}

const liveWorkspaces = async (tx: Db, ids: string[]) =>
  (
    await tx
      .select({ id: powerbiWorkspace.id })
      .from(powerbiWorkspace)
      .where(
        and(
          inArray(powerbiWorkspace.id, ids),
          isNull(powerbiWorkspace.removed_at),
        ),
      )
  )
    .map((row) => row.id)
    .sort();

const liveDatasets = async (tx: Db, ids: string[]) =>
  (
    await tx
      .select({ id: powerbiDataset.id })
      .from(powerbiDataset)
      .where(
        and(inArray(powerbiDataset.id, ids), isNull(powerbiDataset.removed_at)),
      )
  )
    .map((row) => row.id)
    .sort();

const accessRows = (tx: Db, objectId: string) =>
  tx
    .select()
    .from(powerbiAccess)
    .where(eq(powerbiAccess.object_id, objectId))
    .orderBy(powerbiAccess.id);

const datasetName = async (tx: Db, id: string) =>
  (
    await tx
      .select({ name: powerbiDataset.name })
      .from(powerbiDataset)
      .where(eq(powerbiDataset.id, id))
  )[0]?.name;

const measureRows = (tx: Db, datasetId: string) =>
  tx
    .select()
    .from(powerbiMeasure)
    .where(eq(powerbiMeasure.dataset_id, datasetId))
    .orderBy(powerbiMeasure.name);

const scansIn = (calls: MockInstance<AppDeps["fetcher"]["fetchFixed"]>) =>
  calls.mock.calls.filter(([url]) =>
    String(url).includes("/workspaces/getInfo"),
  ).length;

const HOUR_MS = 60 * 60 * 1000;

/** A sync as of some hours back, as Power BI wants modifiedSince 30 minutes old at the least. */
const syncAgo = (deps: AppDeps, hours: number, kind: SyncKind) =>
  runSync(
    { ...deps, clock: () => new Date(Date.now() - hours * HOUR_MS) },
    { kind, trigger: "manual", poll_ms: 1 },
  );

/** A tenant in which no workspace changed after any sync of these tests. */
function unchangedTenant(): Tenant {
  const tenant = sampleTenant();
  for (const workspace of tenant.workspaces)
    workspace.modified_at = "2020-01-01T00:00:00.000Z";
  return tenant;
}

describe("a workspace that cannot be scanned", () => {
  const tooLarge = (tenant: Tenant) =>
    addMeasure(tenant, "Sales", {
      name: "Too long for a scan",
      expression: `"${"x".repeat(SCAN_LIMIT_BYTES)}"`,
    });

  it("fails alone when its answer passes the limit, and the batch it came in is mirrored", async () => {
    const tenant = sampleTenant();
    const fillers = addFillers(tenant, 97);
    tooLarge(tenant);
    const sales = workspaceNamed(tenant, "Commercial").id;
    await withSync(tenant, async (tx, sync) => {
      await expect(sync()).rejects.toThrow(sales);

      const others = [
        workspaceNamed(tenant, "Management").id,
        workspaceNamed(tenant, "Growth").id,
        ...fillers,
      ];
      expect(await liveWorkspaces(tx, [sales, ...others])).toEqual(
        [...others].sort(),
      );
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.workspaces_scanned).toBe(99);
      expect(run.counts).toMatchObject({ workspaces_failed: 1 });
      expect(run.error).toContain(sales);
      expect(run.error).toContain("larger than");
      expect(run.error).toContain("Workspaces to skip");
    });
  });

  it("leaves what was mirrored of it as it was", async () => {
    const tenant = sampleTenant();
    const sales = datasetNamed(tenant, "Sales").id;
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const before = await measureRows(tx, sales);
      tooLarge(tenant);
      await expect(sync()).rejects.toThrow();
      expect(await measureRows(tx, sales)).toEqual(before);
    });
  });

  it("stops failing the run once an admin leaves it out", async () => {
    const tenant = sampleTenant();
    tooLarge(tenant);
    const sales = workspaceNamed(tenant, "Commercial").id;
    await withSync(tenant, async (tx, sync, deps) => {
      await expect(sync()).rejects.toThrow();
      await deps.settings.set(
        "powerbi.sync.workspaces.exclude",
        [sales],
        principals.admin,
      );
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
    });
  });

  it("fails alone when Power BI says its scan failed, in Power BI's words", async () => {
    const tenant = sampleTenant();
    const fillers = addFillers(tenant, 97);
    const finance = workspaceNamed(tenant, "Management");
    finance.scan_failure = "The scan could not read this workspace";
    await withSync(tenant, async (tx, sync) => {
      await expect(sync()).rejects.toThrow(finance.id);
      expect(await liveWorkspaces(tx, fillers)).toEqual([...fillers].sort());
      expect((await lastRun(tx)).error).toContain(finance.scan_failure);
    });
  });

  it("stays inside Microsoft's scan limit when every workspace fails, and bounds what the run stores", async () => {
    const tenant = sampleTenant();
    const fillers = addFillers(tenant, 397);
    for (const workspace of tenant.workspaces)
      workspace.scan_failure = "The scan could not read this workspace";
    await withSync(tenant, async (tx, sync, deps) => {
      const calls = vi.spyOn(deps.fetcher, "fetchFixed");
      await expect(sync()).rejects.toThrow();
      expect(await liveWorkspaces(tx, fillers)).toEqual([]);
      expect(scansIn(calls)).toBeLessThan(500);
      const run = await lastRun(tx);
      expect(run.counts.workspaces_failed).toBeGreaterThan(20);
      expect(run.error?.length).toBeLessThan(10_000);
      expect(run.counts.batches_failed).toBeGreaterThan(0);
    });
  }, 120_000);

  it("holds one answer at a time, however many scans ran together", async () => {
    const tenant = sampleTenant();
    addFillers(tenant, 390);
    await withSync(tenant, async (tx, sync, deps) => {
      const fetchFixed = deps.fetcher.fetchFixed.bind(deps.fetcher);
      let reading = 0;
      let most = 0;
      vi.spyOn(deps.fetcher, "fetchFixed").mockImplementation(
        async (url, init) => {
          if (!String(url).includes("/scanResult/"))
            return fetchFixed(url, init);
          reading += 1;
          most = Math.max(most, reading);
          try {
            return await fetchFixed(url, init);
          } finally {
            reading -= 1;
          }
        },
      );
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
      expect(most).toBe(1);
    });
  }, 60_000);

  it("fails alone when one workspace in the answer cannot be read", async () => {
    const tenant = sampleTenant();
    const fillers = addFillers(tenant, 97);
    const finance = workspaceNamed(tenant, "Management").id;
    await withSync(tenant, async (tx, sync, deps) => {
      const fetchFixed = deps.fetcher.fetchFixed.bind(deps.fetcher);
      vi.spyOn(deps.fetcher, "fetchFixed").mockImplementation(
        async (url, init) => {
          const answer = await fetchFixed(url, init);
          if (!String(url).includes("/scanResult/")) return answer;
          const body = z
            .object({ workspaces: z.array(z.looseObject({ id: z.string() })) })
            .parse(await answer.json());
          for (const workspace of body.workspaces)
            if (workspace.id === finance) workspace.name = 7;
          return new Response(JSON.stringify(body));
        },
      );
      await expect(sync()).rejects.toThrow(finance);
      expect(await liveWorkspaces(tx, fillers)).toEqual([...fillers].sort());
      expect((await lastRun(tx)).counts).toMatchObject({
        workspaces_failed: 1,
      });
    });
  });

  it("records the run and its event when Power BI's sentence is one Postgres could not keep, and cuts a long one", async () => {
    const tenant = sampleTenant();
    const finance = workspaceNamed(tenant, "Management");
    finance.scan_failure = `Bad \u0000 and \ud83d ${"x".repeat(10_000)}`;
    await withSync(tenant, async (tx, sync) => {
      await expect(sync()).rejects.toThrow(finance.id);
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.finished_at).not.toBeNull();
      expect(run.error).not.toContain("\u0000");
      expect(run.error?.isWellFormed()).toBe(true);
      expect(run.error?.length).toBeLessThan(1_000);
      const failed = await tx
        .select()
        .from(event)
        .where(eq(event.kind, "sync.failed"));
      expect(failed).toHaveLength(1);
    });
  });

  it("is not looked for when Power BI refused the asking: a batch that gets a 500 fails whole", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (_tx, sync, deps, mock) => {
      const calls = vi.spyOn(deps.fetcher, "fetchFixed");
      mock.failNext("/powerbi/v1.0/myorg/admin/workspaces/scanResult", 500);
      await expect(sync()).rejects.toThrow(/^A scan of 3 workspaces failed/);
      expect(scansIn(calls)).toBe(1);
    });
  });

  it("is named but not offered to an admin to skip when Power BI fails a scan of it alone, which says nothing of it", async () => {
    const tenant = sampleTenant();
    const finance = workspaceNamed(tenant, "Management").id;
    await withSync(tenant, async (tx, sync, deps, mock) => {
      await deps.settings.set(
        "powerbi.sync.workspaces.include",
        [finance],
        principals.admin,
      );
      mock.failNext("/powerbi/v1.0/myorg/admin/workspaces/scanResult", 500);
      await expect(sync()).rejects.toThrow(
        `Workspace ${finance} could not be scanned`,
      );
      const run = await lastRun(tx);
      expect(run.counts).toMatchObject({ batches_failed: 1 });
      expect(run.counts).not.toHaveProperty("workspaces_failed");
      expect(run.error).not.toContain("Workspaces to skip");
    });
  });
});

describe("the sync after a failed one", () => {
  it("fails again on a workspace that changed since the last success, until it can be read", async () => {
    const tenant = unchangedTenant();
    const finance = workspaceNamed(tenant, "Management");
    await withSync(tenant, async (tx, _sync, deps) => {
      await syncAgo(deps, 6, "full");
      // After the last success and before the first failure, so a sync lists it
      // only if it still goes from that success.
      finance.modified_at = new Date(Date.now() - 5.5 * HOUR_MS).toISOString();
      finance.scan_failure = "The scan could not read this workspace";
      await expect(syncAgo(deps, 5, "incremental")).rejects.toThrow(finance.id);
      await expect(syncAgo(deps, 4, "incremental")).rejects.toThrow(finance.id);

      delete finance.scan_failure;
      await syncAgo(deps, 3, "incremental");
      expect(await lastRun(tx)).toMatchObject({
        status: "succeeded",
        workspaces_scanned: 1,
      });
    });
  });

  it("does not read again what a full sync left of a workspace nothing changed in: it succeeds, and the next full sync tries again", async () => {
    const tenant = unchangedTenant();
    const finance = workspaceNamed(tenant, "Management");
    await withSync(tenant, async (tx, _sync, deps) => {
      await syncAgo(deps, 6, "full");
      finance.scan_failure = "The scan could not read this workspace";
      await expect(syncAgo(deps, 5, "full")).rejects.toThrow(finance.id);
      expect(await syncAgo(deps, 4, "incremental")).toMatchObject({
        status: "succeeded",
        counts: { workspaces_scanned: 0 },
      });
      await expect(syncAgo(deps, 3, "full")).rejects.toThrow(finance.id);

      delete finance.scan_failure;
      await syncAgo(deps, 2, "full");
      expect(await lastRun(tx)).toMatchObject({
        status: "succeeded",
        workspaces_scanned: 3,
      });
    });
  });
});

describe("a dataset or workspace that cannot be stored", () => {
  const VALUES: [string, Partial<Scanned> & { name: string }, RegExp][] = [
    [
      "a NUL in an expression",
      {
        name: "Holds a NUL",
        expression: `COUNTROWS('Sales lines') & "\u0000"`,
      },
      /invalid byte sequence/,
    ],
    [
      "a name too long for its index",
      { name: randomBytes(4_000).toString("base64") },
      /index row size/,
    ],
  ];

  it.each(VALUES)(
    "fails alone with %s: the dataset beside it, and every other workspace, are mirrored",
    async (_, measure, sentence) => {
      const tenant = sampleTenant();
      addMeasure(tenant, "Sales", measure);
      const sales = datasetNamed(tenant, "Sales").id;
      const retail = datasetNamed(tenant, "Retail").id;
      const workspaces = tenant.workspaces
        .filter((w) => w.type !== "PersonalGroup")
        .map((w) => w.id);
      await withSync(tenant, async (tx, sync) => {
        await expect(sync()).rejects.toThrow(sales);

        expect(await liveWorkspaces(tx, workspaces)).toEqual(
          [...workspaces].sort(),
        );
        const datasets = tenant.datasets.map((d) => d.id);
        expect(await liveDatasets(tx, datasets)).toEqual(
          datasets.filter((id) => id !== sales).sort(),
        );
        expect((await measureRows(tx, retail)).length).toBeGreaterThan(0);
        expect(await measureRows(tx, sales)).toEqual([]);

        const run = await lastRun(tx);
        expect(run.status).toBe("failed");
        expect(run.workspaces_scanned).toBe(workspaces.length);
        expect(run.counts).toMatchObject({ datasets_failed: 1 });
        expect(run.error).toMatch(sentence);
        expect(run.error).toContain(sales);
        expect(run.error).not.toContain(measure.name);
      });
    },
  );

  it("leaves what was mirrored of the dataset as it was, its access list too, stores the dataset beside it, and takes it back once it can be stored", async () => {
    const tenant = sampleTenant();
    const sales = datasetNamed(tenant, "Sales");
    const retail = datasetNamed(tenant, "Retail");
    sales.users = workspaceNamed(tenant, "Commercial").users.slice(0, 1);
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const before = await measureRows(tx, sales.id);
      const listed = await accessRows(tx, sales.id);
      expect(listed).toHaveLength(1);

      const refused = addMeasure(tenant, "Sales", {
        name: "Holds a NUL",
        expression: '"\u0000"',
      });
      const wasNamed = sales.name;
      sales.name = "Sales, renamed";
      sales.users = [];
      retail.name = "Retail, renamed";
      await expect(sync()).rejects.toThrow(sales.id);

      expect(await measureRows(tx, sales.id)).toEqual(before);
      expect(await accessRows(tx, sales.id)).toEqual(listed);
      expect(await datasetName(tx, sales.id)).toBe(wasNamed);
      expect(await datasetName(tx, retail.id)).toBe("Retail, renamed");

      refused.expression = "COUNTROWS('Sales lines') * 3";
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
      expect(await datasetName(tx, sales.id)).toBe("Sales, renamed");
      expect(await accessRows(tx, sales.id)).toEqual([]);
      expect((await measureRows(tx, sales.id)).map((m) => m.name)).toContain(
        refused.name,
      );
    });
  });

  it("keeps saying what it left when a later step ends the run", async () => {
    const tenant = sampleTenant();
    addMeasure(tenant, "Sales", {
      name: "Holds a NUL",
      expression: '"\u0000"',
    });
    const sales = datasetNamed(tenant, "Sales").id;
    await withSync(tenant, async (tx, sync) => {
      // Gone when the transaction rolls back.
      await tx.execute(sql`reset role`);
      await tx.execute(sql`set local role migrator`);
      await tx.execute(sql`revoke insert on powerbi_app from worker_rw`);
      await setRole(tx, "worker_rw");
      await expect(sync()).rejects.toThrow();
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("permission denied for table powerbi_app");
      expect(run.error).toContain(sales);
    });
  });

  it("ends the run, and blames no workspace, when Postgres cannot be reached", async () => {
    const tenant = sampleTenant();
    const { mock, deps: powerbi } = await startPowerBi(tenant);
    try {
      await rolledBack(TEST_RUNNER, async (tx) => {
        await setRole(tx, "worker_rw");
        let attempts = 0;
        const unreachable = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "transaction")
              return Reflect.get(target, property, receiver) as unknown;
            attempts += 1;
            if (attempts === 1) throw new Error("connect ECONNREFUSED");
            return target.transaction.bind(target);
          },
        });
        const deps = createTestDeps({
          ...powerbi,
          container: "worker",
          db: unreachable,
        });
        await expect(
          runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 }),
        ).rejects.toThrow("connect ECONNREFUSED");
        const run = await lastRun(tx);
        expect(run.error).toBe("connect ECONNREFUSED");
        expect(run.counts).not.toHaveProperty("workspaces_failed");
      });
    } finally {
      await mock.close();
    }
  });

  it("fails a workspace alone when its own row is refused, and names it", async () => {
    const tenant = sampleTenant();
    const finance = workspaceNamed(tenant, "Management");
    const shown = finance.id;
    finance.name = "Holds a NUL \u0000";
    const others = tenant.workspaces
      .filter((w) => w.type !== "PersonalGroup" && w.id !== shown)
      .map((w) => w.id);
    await withSync(tenant, async (tx, sync) => {
      await expect(sync()).rejects.toThrow(shown);
      expect(await liveWorkspaces(tx, [shown, ...others])).toEqual(
        [...others].sort(),
      );
      const run = await lastRun(tx);
      expect(run.counts).toMatchObject({ workspaces_failed: 1 });
      expect(run.error).toMatch(/invalid byte sequence/);
    });
  });
});

describe("apps", () => {
  const firstApp = (tenant: Tenant) => {
    const [app] = tenant.apps;
    if (app === undefined) throw new Error("The sample has no app");
    return app;
  };

  const appRow = async (tx: Db, id: string) =>
    (await tx.select().from(powerbiApp).where(eq(powerbiApp.id, id)))[0];

  const draftsAndEmbeddingsWentOn = async (tx: Db) => {
    const filed = await tx.select().from(metricVariant);
    expect(filed.length).toBeGreaterThan(0);
    const queued = await tx.select().from(jobRequest);
    expect(queued.map((job) => job.job)).toContain("embed");
  };

  it("fail alone when Postgres refuses a value in one: the app beside it keeps up with Power BI, its audience too", async () => {
    const tenant = sampleTenant();
    const app = firstApp(tenant);
    const other = { ...app, id: randomUUID(), name: "Second app" };
    tenant.apps.push(other);
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const row = await appRow(tx, app.id);
      const audience = await accessRows(tx, app.id);
      expect(audience.length).toBeGreaterThan(1);

      app.description = "Holds a NUL \u0000";
      app.users = app.users.slice(1);
      other.name = "Second app, renamed";
      other.users = other.users.slice(1);
      await expect(sync()).rejects.toThrow(app.id);
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.counts).toMatchObject({
        apps: tenant.apps.length,
        apps_failed: 1,
      });
      expect(run.error).toContain(
        `App ${app.id} in workspace ${app.workspace_id} could not be stored`,
      );
      expect(run.error).toMatch(/invalid byte sequence/);
      expect(run.error).toContain("Workspaces to skip");
      await draftsAndEmbeddingsWentOn(tx);

      expect(await appRow(tx, app.id)).toEqual(row);
      expect(await accessRows(tx, app.id)).toEqual(audience);
      expect((await appRow(tx, other.id))?.name).toBe("Second app, renamed");
      expect(await accessRows(tx, other.id)).toHaveLength(other.users.length);

      app.description = "Holds no NUL";
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
      expect((await appRow(tx, app.id))?.description_pbi).toBe("Holds no NUL");
      expect(await accessRows(tx, app.id)).toHaveLength(app.users.length);
    });
  });

  const usersOf = (id: string) => `/powerbi/v1.0/myorg/admin/apps/${id}/users`;

  it("keep failing the run until a full sync removes the workspace an admin left out", async () => {
    const tenant = unchangedTenant();
    const app = firstApp(tenant);
    await withSync(tenant, async (tx, _sync, deps) => {
      await syncAgo(deps, 6, "full");
      app.description = "Holds a NUL \u0000";
      await expect(syncAgo(deps, 5, "incremental")).rejects.toThrow(app.id);
      await deps.settings.set(
        "powerbi.sync.workspaces.exclude",
        [app.workspace_id],
        principals.admin,
      );
      await expect(syncAgo(deps, 4, "incremental")).rejects.toThrow(app.id);

      await syncAgo(deps, 3, "full");
      expect((await lastRun(tx)).status).toBe("succeeded");
      expect(await liveWorkspaces(tx, [app.workspace_id])).toEqual([]);
    });
  });

  it("wait for the next full sync once one could not read an audience: the incremental syncs between do not read it", async () => {
    const tenant = unchangedTenant();
    const app = firstApp(tenant);
    await withSync(tenant, async (tx, _sync, deps, mock) => {
      await syncAgo(deps, 6, "full");
      const audience = await accessRows(tx, app.id);
      app.users = app.users.slice(1);
      mock.failNext(usersOf(app.id), 404);
      await expect(syncAgo(deps, 5, "full")).rejects.toThrow(app.id);

      expect(await syncAgo(deps, 4, "incremental")).toMatchObject({
        status: "succeeded",
      });
      expect(await accessRows(tx, app.id)).toEqual(audience);

      await syncAgo(deps, 3, "full");
      expect(await accessRows(tx, app.id)).toHaveLength(app.users.length);
    });
  });

  describe("whose audience cannot be read", () => {
    /** After a first sync, the first app renamed and both apps' audiences a person shorter. */
    async function withChangedApps(
      work: (
        tx: Db,
        sync: () => Promise<unknown>,
        deps: AppDeps,
        mock: MockPowerBiHandle,
        apps: {
          app: Tenant["apps"][number];
          other: Tenant["apps"][number];
          audience: Awaited<ReturnType<typeof accessRows>>;
        },
      ) => Promise<void>,
    ): Promise<void> {
      const tenant = sampleTenant();
      const app = firstApp(tenant);
      const other = { ...app, id: randomUUID(), name: "Second app" };
      tenant.apps.push(other);
      await withSync(tenant, async (tx, sync, deps, mock) => {
        await sync();
        const audience = await accessRows(tx, app.id);
        app.name = "First app, renamed";
        app.users = app.users.slice(1);
        other.users = other.users.slice(1);
        await work(tx, sync, deps, mock, { app, other, audience });
      });
    }

    const failedAlone = async (
      tx: Db,
      {
        app,
        other,
        audience,
      }: Parameters<Parameters<typeof withChangedApps>[0]>[4],
    ) => {
      const run = await lastRun(tx);
      expect(run.counts).toMatchObject({ apps_failed: 1 });
      expect(run.counts).not.toHaveProperty("apps_not_synced");
      expect(run.error).toContain(
        `The audience of app ${app.id} in workspace ${app.workspace_id} could not be read`,
      );
      expect((await appRow(tx, app.id))?.name).toBe("First app, renamed");
      expect(await accessRows(tx, app.id)).toEqual(audience);
      expect(await accessRows(tx, other.id)).toHaveLength(other.users.length);
    };

    it("fail alone when Power BI no longer knows the app", () =>
      withChangedApps(async (tx, sync, _deps, mock, apps) => {
        mock.failNext(usersOf(apps.app.id), 404);
        await expect(sync()).rejects.toThrow(apps.app.id);
        await failedAlone(tx, apps);
      }));

    it("fail alone when one entry in the audience cannot be read", () =>
      withChangedApps(async (tx, sync, deps, _mock, apps) => {
        const fetchFixed = deps.fetcher.fetchFixed.bind(deps.fetcher);
        vi.spyOn(deps.fetcher, "fetchFixed").mockImplementation((url, init) =>
          String(url).includes(`/apps/${apps.app.id}/users`)
            ? Promise.resolve(
                new Response(
                  JSON.stringify({ value: [{ principalType: "Robot" }] }),
                ),
              )
            : fetchFixed(url, init),
        );
        await expect(sync()).rejects.toThrow(apps.app.id);
        await failedAlone(tx, apps);
      }));

    it("count once when its row cannot be stored either, and say both", () =>
      withChangedApps(async (tx, sync, _deps, mock, { app }) => {
        mock.failNext(usersOf(app.id), 404);
        app.description = "Holds a NUL \u0000";
        await expect(sync()).rejects.toThrow(app.id);
        const run = await lastRun(tx);
        expect(run.counts).toMatchObject({ apps_failed: 1 });
        expect(run.error).toContain(`The audience of app ${app.id}`);
        expect(run.error).toContain(`App ${app.id} in workspace`);
      }));

    it("leave every app waiting when Power BI fails the read, which says nothing of the app", () =>
      withChangedApps(async (tx, sync, _deps, mock, { app, audience }) => {
        mock.failNext(usersOf(app.id), 500);
        await expect(sync()).rejects.toThrow(/500/);
        const run = await lastRun(tx);
        expect(run.counts).toMatchObject({ apps_not_synced: 1 });
        expect(run.counts).not.toHaveProperty("apps_failed");
        expect((await appRow(tx, app.id))?.name).not.toBe("First app, renamed");
        expect(await accessRows(tx, app.id)).toEqual(audience);
        await draftsAndEmbeddingsWentOn(tx);
      }));

    it.each([
      ["a 200", 200, /cannot read/],
      ["a 404", 404, /404/],
    ])(
      "leave every app waiting when a gateway answers the read with its page and %s, which says nothing of the app",
      (_status, status, said) =>
        withChangedApps(async (tx, sync, deps, _mock, { app, audience }) => {
          const fetchFixed = deps.fetcher.fetchFixed.bind(deps.fetcher);
          vi.spyOn(deps.fetcher, "fetchFixed").mockImplementation(
            (url, init) =>
              String(url).includes(`/apps/${app.id}/users`)
                ? Promise.resolve(
                    new Response("<html>A gateway's page</html>", { status }),
                  )
                : fetchFixed(url, init),
          );
          await expect(sync()).rejects.toThrow(said);
          const run = await lastRun(tx);
          expect(run.counts).toMatchObject({ apps_not_synced: 1 });
          expect(run.counts).not.toHaveProperty("apps_failed");
          expect(await accessRows(tx, app.id)).toEqual(audience);
          await draftsAndEmbeddingsWentOn(tx);
        }),
    );
  });

  it("keep saying which one failed when a later one ends the run", async () => {
    const tenant = sampleTenant();
    const app = firstApp(tenant);
    const other = {
      ...app,
      id: randomUUID(),
      name: "Second app",
      // Microsoft writes this field: it stands here for any failure no app's data explains.
      last_update: "not a date",
    };
    tenant.apps.push(other);
    app.description = "Holds a NUL \u0000";
    await withSync(tenant, async (tx, sync) => {
      await expect(sync()).rejects.toThrow(RangeError);
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.error).toContain(`App ${app.id} in workspace`);
      expect(run.counts).toMatchObject({ apps_failed: 1 });
    });
  });

  it("wait for the next sync when Power BI does not answer for them: the drafts and embeddings go on", async () => {
    await withSync(sampleTenant(), async (tx, sync, _deps, mock) => {
      mock.failNext("/powerbi/v1.0/myorg/admin/apps", 500);
      await expect(sync()).rejects.toThrow(/500/);
      const run = await lastRun(tx);
      expect(run.status).toBe("failed");
      expect(run.counts).toMatchObject({ apps_not_synced: 1 });
      expect(run.error).toContain("The apps could not be synced");
      await draftsAndEmbeddingsWentOn(tx);
    });
  });

  it("take an audience past what one statement can carry", async () => {
    const tenant = sampleTenant();
    const app = firstApp(tenant);
    app.users = Array.from({ length: 10_000 }, (_, n) => ({
      principal_type: "User",
      object_id: randomUUID(),
      email: `person-${String(n)}@sample.example`,
      access_right: "Read",
    }));
    await withSync(tenant, async (tx, sync) => {
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
      expect(await accessRows(tx, app.id)).toHaveLength(10_000);
    });
  }, 60_000);

  it("take a workspace with more reports than a call's arguments can carry", async () => {
    const tenant = sampleTenant();
    const finance = workspaceNamed(tenant, "Management").id;
    await withSync(tenant, async (tx, sync, deps) => {
      const fetchFixed = deps.fetcher.fetchFixed.bind(deps.fetcher);
      vi.spyOn(deps.fetcher, "fetchFixed").mockImplementation(
        async (url, init) => {
          const answer = await fetchFixed(url, init);
          if (!String(url).includes("/scanResult/")) return answer;
          const body = z
            .object({ workspaces: z.array(z.looseObject({ id: z.string() })) })
            .parse(await answer.json());
          for (const workspace of body.workspaces)
            if (workspace.id === finance)
              workspace.reports = Array.from({ length: 300_000 }, (_, n) => ({
                id: String(n),
                name: "A report",
              }));
          return new Response(JSON.stringify(body));
        },
      );
      await sync();
      expect((await lastRun(tx)).status).toBe("succeeded");
    });
  }, 60_000);
});
