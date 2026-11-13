import { randomUUID } from "node:crypto";
import {
  EXPECTED_DRAFTS,
  type MockPowerBiHandle,
  sampleTenant,
  type Tenant,
} from "@powerbi-metrics-book/powerbi-mock";
import {
  and,
  desc,
  eq,
  inArray,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  closeTestPools,
  createTestDeps,
  testPool,
  principals,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { find, startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { AppDeps, Db } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import * as schema from "../../db/schema/index.js";
import {
  powerbiAccess,
  powerbiApp,
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
  powerbiWorkspace,
  syncRun,
} from "../../db/schema/mirror.js";
import { handlerFor } from "../jobs/registry.js";
import { runSync, type SyncKind, type SyncOutcome } from "./run.js";
import { storeWorkspace } from "./store.js";

afterAll(closeTestPools);

const GET_INFO = "/powerbi/v1.0/myorg/admin/workspaces/getInfo";
const SALES = "Sales";

type Sync = (kind?: SyncKind) => Promise<SyncOutcome>;

/**
 * Syncs the tenant through the mock into one transaction that is always
 * rolled back, as the worker, so no test commits the sample's fixed ids.
 */
async function withSync(
  tenant: Tenant,
  work: (
    tx: Db,
    sync: Sync,
    mock: MockPowerBiHandle,
    deps: AppDeps,
  ) => Promise<void>,
): Promise<void> {
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const deps = createTestDeps({ ...powerbi, container: "worker", db: tx });
      const sync: Sync = (kind = "full") =>
        runSync(deps, { kind, trigger: "manual", poll_ms: 1 });
      await work(tx, sync, mock, deps);
    });
  } finally {
    await mock.close();
  }
}

/** Every mirror row under the sample tenant's ids, without when the sync last saw it. */
async function mirrorOf(tx: Db) {
  const sample = sampleTenant();
  const workspaces = sample.workspaces.map((w) => w.id);
  const datasets = sample.datasets.map((d) => d.id);
  const apps = sample.apps.map((a) => a.id);
  const read = async <T extends { id: string }>(
    rows: PromiseLike<T[]>,
  ): Promise<(Omit<T, "synced_at"> & { synced_at: null })[]> =>
    (await rows)
      .map((row) => ({ ...row, synced_at: null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const inDatasets = (table: { dataset_id: AnyPgColumn }) =>
    inArray(table.dataset_id, datasets);
  const objects = [...workspaces, ...datasets, ...apps];
  const { app_id, dataset_id } = powerbiAppDataset;
  const select = () => tx.select();
  return {
    workspaces: await read(
      select()
        .from(powerbiWorkspace)
        .where(inArray(powerbiWorkspace.id, workspaces)),
    ),
    datasets: await read(
      select().from(powerbiDataset).where(inArray(powerbiDataset.id, datasets)),
    ),
    tables: await read(
      select().from(powerbiTable).where(inDatasets(powerbiTable)),
    ),
    columns: await read(
      select().from(powerbiColumn).where(inDatasets(powerbiColumn)),
    ),
    measures: await read(
      select().from(powerbiMeasure).where(inDatasets(powerbiMeasure)),
    ),
    relationships: await read(
      select().from(powerbiRelationship).where(inDatasets(powerbiRelationship)),
    ),
    apps: await read(
      select().from(powerbiApp).where(inArray(powerbiApp.id, apps)),
    ),
    app_datasets: await select()
      .from(powerbiAppDataset)
      .where(inArray(app_id, apps))
      .orderBy(app_id, dataset_id),
    access: await read(
      select()
        .from(powerbiAccess)
        .where(inArray(powerbiAccess.object_id, objects)),
    ),
  };
}

const datasetNamed = (tenant: Tenant, name: string) =>
  find(tenant.datasets, (d) => d.name === name);

/** Gives the Sales dataset's measures named `from` the name `to`, or drops them. */
function editMeasure(tenant: Tenant, from: string, to: string | null): void {
  for (const table of datasetNamed(tenant, SALES).tables) {
    table.measures = table.measures.filter(
      (m) => to !== null || m.name !== from,
    );
    for (const m of table.measures) if (m.name === from && to) m.name = to;
  }
}

async function measureNamed(tx: Db, tenant: Tenant, name: string) {
  const dataset = datasetNamed(tenant, SALES).id;
  const { dataset_id, name: named } = powerbiMeasure;
  const [row] = await tx
    .select()
    .from(powerbiMeasure)
    .where(and(eq(dataset_id, dataset), eq(named, name)));
  if (row === undefined) throw new Error(`no measure ${name}`);
  return row;
}

async function filingOf(tx: Db, measureId: string) {
  const { measure_id } = metricVariant;
  const [row] = await tx
    .select()
    .from(metricVariant)
    .where(eq(measure_id, measureId));
  if (row === undefined) throw new Error("the measure was not drafted");
  return row;
}

async function lastRun(tx: Db) {
  const runs = tx.select().from(syncRun);
  const [row] = await runs.orderBy(desc(syncRun.started_at)).limit(1);
  return row;
}

describe("runSync", () => {
  it("leaves the workspaces of a batch whose scan failed exactly as they were", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync, mock) => {
      await sync();
      const before = await mirrorOf(tx);
      find(tenant.workspaces, (w) => w.name === SALES).name += ", renamed";
      editMeasure(tenant, "Return rate", null);
      // The sample's three workspaces and the first 97 of these make batch 1.
      const fillers = Array.from({ length: 100 }, (_, n) => ({
        id: randomUUID(),
        type: "Workspace",
        state: "Active",
        name: `Filler ${String(n)}`,
        users: [],
        dataset_ids: [],
        report_ids: [],
      }));
      tenant.workspaces.push(...fillers);
      mock.failNext(GET_INFO, 500);

      await expect(sync()).rejects.toThrow(/^A scan of 100 workspaces failed/);

      expect(await mirrorOf(tx)).toEqual(before);
      const ids = fillers.map((f) => f.id);
      const stored = await tx
        .select({ id: powerbiWorkspace.id })
        .from(powerbiWorkspace)
        .where(inArray(powerbiWorkspace.id, ids));
      const second = ids.slice(97).sort();
      expect(stored.map((row) => row.id).sort()).toEqual(second);
      expect(await lastRun(tx)).toMatchObject({
        status: "failed",
        workspaces_scanned: 3,
      });
    });
  });

  it("stores what the sample tenant holds, without the mashup, and drafts it", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      // With no earlier sync, an incremental one scans everything.
      const outcome = await sync("incremental");
      expect(outcome).toMatchObject({ kind: "full", status: "succeeded" });
      const mirror = await mirrorOf(tx);

      const names = (items: { name: string }[]) => items.map((i) => i.name);
      const shared = tenant.workspaces.filter(
        (w) => w.type !== "PersonalGroup",
      );
      expect(names(mirror.workspaces).sort()).toEqual(names(shared).sort());
      const errors = (items: { name: string; error: string | null }[]) =>
        items.map((i) => `${i.name}: ${String(i.error)}`).sort();
      expect(
        errors(mirror.datasets.map((d) => ({ ...d, error: d.schema_error }))),
      ).toEqual(
        errors(
          tenant.datasets.map((d) => ({
            ...d,
            error: d.schema_retrieval_error,
          })),
        ),
      );
      const tables = tenant.datasets.flatMap((d) => d.tables);
      expect(mirror.tables).toHaveLength(tables.length);
      const columns = tables.flatMap((t) => t.columns);
      expect(mirror.columns).toHaveLength(columns.length);
      const expressions = (items: { expression: string | null }[]) =>
        items.map((i) => i.expression).sort();
      expect(expressions(mirror.measures)).toEqual(
        expressions(tables.flatMap((t) => t.measures)),
      );
      expect(new Set(mirror.columns.map((c) => c.column_type))).toEqual(
        new Set(["data", "calculated", "calculated_table_column"]),
      );
      // The mock sends M for every table and a parameter for every dataset.
      const stored = JSON.stringify(mirror);
      for (const mashup of ["Sql.Database", "SampleServer", "sample-server"])
        expect(stored).not.toContain(mashup);

      const filed = await tx
        .select({
          dataset: powerbiDataset.name,
          measure: powerbiMeasure.name,
          metric: metricVariant.metric_id,
        })
        .from(metricVariant)
        .innerJoin(
          powerbiMeasure,
          eq(powerbiMeasure.id, metricVariant.measure_id),
        )
        .innerJoin(
          powerbiDataset,
          eq(powerbiDataset.id, powerbiMeasure.dataset_id),
        );
      const metricOf = new Map(
        filed.map((row) => [`${row.dataset}/${row.measure}`, row.metric]),
      );
      for (const draft of EXPECTED_DRAFTS) {
        const metrics = [...draft.base, ...draft.variants].map((m) =>
          metricOf.get(`${m.dataset}/${m.measure}`),
        );
        expect(new Set(metrics).size, JSON.stringify(draft.base)).toBe(1);
        expect(metrics[0]).toBeDefined();
      }
    });
  });

  it("stamps a real change, writes nothing new when nothing changed, and skips an incremental sync within 30 minutes", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const first = await mirrorOf(tx);
      for (const table of datasetNamed(tenant, SALES).tables)
        for (const m of table.measures)
          if (m.name === "Return rate") m.expression += " + 0";
      await sync();
      const changed = await mirrorOf(tx);
      const sales = datasetNamed(tenant, SALES).id;
      for (const dataset of changed.datasets) {
        const was = find(first.datasets, (d) => d.id === dataset.id);
        const kept =
          dataset.schema_changed_at?.getTime() ===
          was.schema_changed_at?.getTime();
        expect(kept, dataset.name).toBe(dataset.id !== sales);
      }
      const stamped = changed.measures.filter((m) => m.expression_changed_at);
      expect(stamped.map((m) => m.name)).toEqual(["Return rate"]);

      await sync();
      expect(await mirrorOf(tx)).toEqual(changed);
      expect(await sync("incremental")).toMatchObject({ status: "skipped" });
      const last = await lastRun(tx);
      expect(last).toMatchObject({ kind: "incremental", status: "skipped" });
    });
  });

  it("drafts every dataset that is on, so a rule that changed reaches what no sync changed", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const { id } = await measureNamed(tx, tenant, "Return rate");
      await tx.delete(metricVariant).where(eq(metricVariant.measure_id, id));
      await sync();
      expect(await filingOf(tx, id)).toMatchObject({ assigned_by: "sync" });
      expect((await lastRun(tx))?.counts).toMatchObject({ drafts_filed: 1 });
      expect((await lastRun(tx))?.counts).not.toHaveProperty(
        "datasets_changed",
        1,
      );
    });
  });

  it("runs as the worker's sync job with the args the worker enqueues", async () => {
    await withSync(sampleTenant(), async (tx) => {
      // A sync ten minutes ago: this incremental one is skipped and calls nothing.
      const started_at = new Date(Date.now() - 10 * 60_000);
      await tx.insert(syncRun).values({
        kind: "full",
        trigger: "schedule",
        status: "succeeded",
        started_at,
      });
      const job = handlerFor("sync", "worker");
      if (job === undefined) throw new Error("no sync job is registered");
      const deps = createTestDeps({
        container: "worker",
        db: tx,
        // Set up, so it is skipped for being too soon; it never gets to ask.
        settings: new MemorySettings({
          "powerbi.tenant_id": "tenant",
          "powerbi.scanner_client_id": "scanner",
        }),
        secrets: new MemorySecrets([["powerbi_scanner_client_secret", "x"]]),
      });
      await job.handler(deps, { kind: "incremental" }, "deploy");
      const last = await lastRun(tx);
      expect(last).toMatchObject({
        kind: "incremental",
        trigger: "deploy",
        status: "skipped",
      });
      expect(last?.error).toMatch(/^The last successful sync started 10 /);
      expect(job.runner).toBe("worker");
    });
  });

  it("skips a sync, with its reason, while the scanner is not set up", async () => {
    await withSync(sampleTenant(), async (tx) => {
      // No scanner secret, and the fetcher refuses every call.
      const deps = createTestDeps({
        container: "worker",
        db: tx,
        settings: new MemorySettings({
          "powerbi.tenant_id": "tenant",
          "powerbi.scanner_client_id": "scanner",
        }),
      });
      expect(
        await runSync(deps, { kind: "full", trigger: "deploy" }),
      ).toMatchObject({ status: "skipped" });
      expect(await lastRun(tx)).toMatchObject({
        kind: "full",
        status: "skipped",
        error:
          "The scanner is not set up yet, so there is nothing to sync. The setup's scanner step sets it up.",
      });
    });
  });

  describe("a sync nobody started", () => {
    const NOT_STARTED =
      "The setup has not started the first sync yet, so this sync is skipped. The setup's What to sync step starts it.";

    it.each(["schedule", "deploy"] as const)(
      "skips a %s sync before the setup's first sync, and asks Power BI nothing",
      async (trigger) => {
        await withSync(sampleTenant(), async (tx, _sync, _mock, deps) => {
          const job = handlerFor("sync", "worker");
          if (job === undefined) throw new Error("no sync job is registered");
          const calls = vi.spyOn(deps.fetcher, "fetchFixed");
          await job.handler(deps, { kind: "incremental" }, trigger);
          expect(await lastRun(tx)).toMatchObject({
            trigger,
            status: "skipped",
            error: NOT_STARTED,
          });
          expect(calls).not.toHaveBeenCalled();
        });
      },
    );

    it("runs the sync the setup's Start queues, whose trigger is manual", async () => {
      await withSync(sampleTenant(), async (tx, sync) => {
        expect(await sync("full")).toMatchObject({ status: "succeeded" });
        expect(await lastRun(tx)).toMatchObject({
          trigger: "manual",
          status: "succeeded",
        });
      });
    });

    it.each(["schedule", "deploy"] as const)(
      "runs a %s sync once a sync has run, though setup has not finished",
      async (trigger) => {
        await withSync(sampleTenant(), async (tx, sync, _mock, deps) => {
          await sync("full");
          const outcome = await runSync(deps, {
            kind: "full",
            trigger,
            poll_ms: 1,
          });
          expect(outcome.status).toBe("succeeded");
          expect(await deps.settings.get("setup.completed_at")).toBeNull();
          expect(await lastRun(tx)).toMatchObject({ trigger });
        });
      },
    );

    it("retries on the schedule after a first sync that failed", async () => {
      await withSync(sampleTenant(), async (tx, _sync, _mock, deps) => {
        await tx.insert(syncRun).values({
          kind: "full",
          trigger: "manual",
          status: "failed",
          started_at: new Date(Date.now() - 60 * 60_000),
        });
        expect(
          await runSync(deps, {
            kind: "incremental",
            trigger: "schedule",
            poll_ms: 1,
          }),
        ).toMatchObject({ kind: "full", status: "succeeded" });
      });
    });

    it.each(["schedule", "deploy", "manual"] as const)(
      "runs a %s sync on a deployment past setup that has no sync on record",
      async (trigger) => {
        await withSync(sampleTenant(), async (_tx, _sync, _mock, deps) => {
          await deps.settings.set(
            "setup.completed_at",
            new Date().toISOString(),
            principals.admin,
          );
          expect(
            await runSync(deps, { kind: "full", trigger, poll_ms: 1 }),
          ).toMatchObject({ status: "succeeded" });
        });
      },
    );

    it("does not count a skipped sync as started", async () => {
      await withSync(sampleTenant(), async (tx, _sync, _mock, deps) => {
        for (const trigger of ["deploy", "schedule"] as const)
          expect(
            await runSync(deps, { kind: "incremental", trigger }),
          ).toMatchObject({ status: "skipped" });
        expect(await lastRun(tx)).toMatchObject({ error: NOT_STARTED });
      });
    });
  });

  it("keeps a curator's icon on a workspace and a dataset through the next sync", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const named = find(tenant.workspaces, (w) => w.name === SALES);
      const datasetId = find(named.dataset_ids, () => true);
      await tx
        .update(powerbiWorkspace)
        .set({ icon: "emoji:📈" })
        .where(eq(powerbiWorkspace.id, named.id));
      await tx
        .update(powerbiDataset)
        .set({ icon: "glyph:chart-line:green" })
        .where(eq(powerbiDataset.id, datasetId));
      named.name += ", renamed";

      await sync();

      const [workspace] = await tx
        .select({ icon: powerbiWorkspace.icon })
        .from(powerbiWorkspace)
        .where(eq(powerbiWorkspace.id, named.id));
      const [dataset] = await tx
        .select({ icon: powerbiDataset.icon })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, datasetId));
      expect(workspace?.icon).toBe("emoji:📈");
      expect(dataset?.icon).toBe("glyph:chart-line:green");
    });
  });

  it("removes a workspace a full sync no longer lists, with everything in it, and keeps its filings", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const named = "Marketing";
      const marketing = find(tenant.workspaces, (w) => w.name === named);
      const inside = [marketing.id, ...marketing.dataset_ids];
      const measures = await tx
        .select({ id: powerbiMeasure.id })
        .from(powerbiMeasure)
        .where(inArray(powerbiMeasure.dataset_id, marketing.dataset_ids));
      const { measure_id } = metricVariant;
      const ids = measures.map((m) => m.id);
      const variants = () =>
        tx
          .select()
          .from(metricVariant)
          .where(inArray(measure_id, ids))
          .orderBy(metricVariant.id);
      const filed = await variants();
      const metricIds = filed.map((v) => v.metric_id);
      const metrics = () =>
        tx.select().from(metric).where(inArray(metric.id, metricIds));
      // A curator's filings, which no sync may move.
      await tx
        .update(metric)
        .set({ touched_at: new Date() })
        .where(inArray(metric.id, metricIds));
      const curated = await metrics();
      tenant.workspaces = tenant.workspaces.filter((w) => w !== marketing);

      await sync();

      const mirror = await mirrorOf(tx);
      const rows = [
        ...mirror.workspaces,
        ...mirror.datasets,
        ...mirror.tables,
        ...mirror.columns,
        ...mirror.measures,
      ].filter((row) =>
        inside.includes("dataset_id" in row ? row.dataset_id : row.id),
      );
      expect(rows.length).toBeGreaterThan(ids.length);
      expect(rows.filter((row) => row.removed_at === null)).toEqual([]);
      const lists = mirror.access.filter((a) => inside.includes(a.object_id));
      expect(lists).toEqual([]);
      expect(filed.length).toBeGreaterThan(0);
      expect(await variants()).toEqual(filed);
      expect(await metrics()).toEqual(curated);
    });
  });

  it("drafts a removed dataset again while a measure of it should leave its draft", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const marketing = find(tenant.workspaces, (w) => w.name === "Marketing");
      tenant.workspaces = tenant.workspaces.filter((w) => w !== marketing);
      await sync();
      // As a book older than the rule left it: a measure of the removed dataset
      // filed in a draft named from another dataset.
      const [adSpend] = await tx
        .select()
        .from(powerbiMeasure)
        .where(
          and(
            inArray(powerbiMeasure.dataset_id, marketing.dataset_ids),
            eq(powerbiMeasure.name, "Ad spend"),
          ),
        );
      if (adSpend === undefined) throw new Error("no measure Ad spend");
      const units = await measureNamed(tx, tenant, "Units sold");
      const held = await filingOf(tx, units.id);
      const filings = () =>
        tx
          .select()
          .from(metricVariant)
          .where(eq(metricVariant.measure_id, adSpend.id));
      await tx.insert(metricVariant).values({
        metric_id: held.metric_id,
        measure_id: adSpend.id,
        assigned_by: "sync",
      });
      expect(await filings()).toHaveLength(1);

      await sync();

      expect(await filings()).toEqual([]);
      expect((await filingOf(tx, units.id)).metric_id).toBe(held.metric_id);
    });
  });

  it("drafts a dataset turned on, and not one that stays off", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const units = await measureNamed(tx, tenant, "Units sold");
      const shift = await measureNamed(tx, tenant, "Units sold PM");
      const held = await filingOf(tx, units.id);
      const sales = datasetNamed(tenant, SALES).id;
      const setSales = (enabled: boolean) =>
        tx
          .update(powerbiDataset)
          .set({ enabled })
          .where(eq(powerbiDataset.id, sales));
      // Filed under a draft of no measure of that dataset's own, as an older book could be.
      await tx
        .update(metric)
        .set({ name: "older_name", label: "Older name" })
        .where(eq(metric.id, held.metric_id));
      await setSales(false);

      await sync();
      expect((await filingOf(tx, shift.id)).metric_id).toBe(held.metric_id);

      await setSales(true);
      await sync();
      expect((await filingOf(tx, units.id)).metric_id).not.toBe(held.metric_id);
    });
  });

  it("drafts a dataset an admin turned on with no scan, just after a sync", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync, _mock, deps) => {
      await sync();
      const job = handlerFor("sync", "worker");
      if (job === undefined) throw new Error("no sync job");
      const units = await measureNamed(tx, tenant, "Units sold");
      const held = await filingOf(tx, units.id);
      const sales = datasetNamed(tenant, SALES).id;
      await tx
        .update(metric)
        .set({ name: "older_name", label: "Older name" })
        .where(eq(metric.id, held.metric_id));
      const runs = async () => (await tx.select().from(syncRun)).length;
      const before = await runs();
      const setSales = (enabled: boolean) =>
        tx
          .update(powerbiDataset)
          .set({ enabled })
          .where(eq(powerbiDataset.id, sales));
      const asked = { draft_dataset: sales };

      // Turned off again before the job ran: the switch stops a crafted model.
      await setSales(false);
      await job.handler(deps, asked, "schedule");
      expect((await filingOf(tx, units.id)).metric_id).toBe(held.metric_id);

      await setSales(true);
      await job.handler(deps, asked, "schedule");
      expect((await filingOf(tx, units.id)).metric_id).not.toBe(held.metric_id);
      expect(await runs()).toBe(before);
    });
  });

  it("marks a measure gone from Power BI removed and deletes its untouched draft", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const measure = await measureNamed(tx, tenant, "Return rate");
      const filing = await filingOf(tx, measure.id);
      editMeasure(tenant, "Return rate", null);
      await sync();
      const gone = await measureNamed(tx, tenant, "Return rate");
      expect(gone.removed_at).not.toBeNull();
      const draft = eq(metric.id, filing.metric_id);
      expect(await tx.select().from(metric).where(draft)).toEqual([]);
    });
  });

  it("brings a measure back under its own id and variant", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const measure = await measureNamed(tx, tenant, "Units sold PM");
      const filing = await filingOf(tx, measure.id);
      const table = find(datasetNamed(tenant, SALES).tables, (t) =>
        t.measures.some((m) => m.name === measure.name),
      );
      const all = table.measures;
      table.measures = all.filter((m) => m.name !== measure.name);
      await sync();
      const gone = await measureNamed(tx, tenant, measure.name);
      expect(gone.removed_at).not.toBeNull();
      table.measures = all;
      await sync();
      const back = await measureNamed(tx, tenant, measure.name);
      expect(back).toMatchObject({ id: measure.id, removed_at: null });
      expect(await filingOf(tx, measure.id)).toEqual(filing);
    });
  });

  it("keeps a renamed measure's row and variant", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const measure = await measureNamed(tx, tenant, "Units sold PM");
      const filing = await filingOf(tx, measure.id);
      editMeasure(tenant, "Units sold PM", "Units sold last month");
      await sync();
      const renamed = await measureNamed(tx, tenant, "Units sold last month");
      expect(renamed).toMatchObject({ id: measure.id, removed_at: null });
      expect(await filingOf(tx, measure.id)).toEqual(filing);
    });
  });

  it("keeps the tables of a dataset whose schema Power BI could not read", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const before = await mirrorOf(tx);
      const sales = datasetNamed(tenant, SALES);
      sales.schema_retrieval_error = "the model was not refreshed";
      await sync();
      const after = await mirrorOf(tx);
      expect(after.tables).toEqual(before.tables);
      expect(after.measures).toEqual(before.measures);
      expect(after.datasets.find((d) => d.id === sales.id)).toMatchObject({
        schema_error: sales.schema_retrieval_error,
      });
    });
  });

  it("stores the datasets behind each app and the tenant's access lists", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const mirror = await mirrorOf(tx);
      const datasetOf = (report: string) =>
        find(tenant.reports, (r) => r.id === report).dataset_id;
      const shown = tenant.apps.flatMap((app) =>
        app.report_ids.map((r) => ({
          app_id: app.id,
          dataset_id: datasetOf(r),
        })),
      );
      expect(mirror.app_datasets).toEqual(
        shown.sort((a, b) => a.app_id.localeCompare(b.app_id)),
      );

      const lists = [
        ...tenant.workspaces
          .filter((w) => w.type !== "PersonalGroup")
          .map((w) => ["workspace", w] as const),
        ...tenant.datasets.map((d) => ["dataset", d] as const),
        ...tenant.apps.map((a) => ["app", a] as const),
      ];
      const expected = lists.flatMap(([kind, { id, users }]) =>
        users.map((u) =>
          [
            kind,
            id,
            u.principal_type.toLowerCase(),
            u.object_id,
            u.access_right,
          ].join(" "),
        ),
      );
      const stored = mirror.access.map((a) =>
        [
          a.object_kind,
          a.object_id,
          a.principal_type,
          a.principal_object_id,
          a.access_right,
        ].join(" "),
      );
      expect(stored.sort()).toEqual(expected.sort());
    });
  });

  it("keeps the stored access of a workspace the scanner answers with users: null", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const sales = find(tenant.workspaces, (w) => w.name === SALES);
      const stored = async () =>
        (await mirrorOf(tx)).access
          .filter((a) => a.object_id === sales.id)
          .map((a) => `${a.principal_type} ${a.principal_object_id}`)
          .sort();
      const before = await stored();
      expect(before).toHaveLength(sales.users.length);

      sales.users_unlisted = true;
      await sync();

      expect(await stored()).toEqual(before);
    });
  });

  it("counts the access lists a scan did not send, each run", async () => {
    const tenant = sampleTenant();
    await withSync(tenant, async (_tx, sync) => {
      expect((await sync()).counts.access_lists_unsent).toBe(0);

      const sales = find(tenant.workspaces, (w) => w.name === SALES);
      sales.users_unlisted = true;
      expect((await sync()).counts.access_lists_unsent).toBe(1);

      sales.users_unlisted = false;
      expect((await sync()).counts.access_lists_unsent).toBe(0);
    });
  });

  it("ends the run on a failed query the data did not cause, as Postgres's own message without the query or its parameters", async () => {
    await withSync(sampleTenant(), async (tx, sync) => {
      // Gone when the transaction rolls back.
      await tx.execute(sql`reset role`);
      await tx.execute(sql`set local role migrator`);
      await tx.execute(sql`revoke insert on powerbi_workspace from worker_rw`);
      await setRole(tx, "worker_rw");
      await expect(sync()).rejects.toThrow();
      const run = await lastRun(tx);
      expect(run?.status).toBe("failed");
      expect(run?.workspaces_scanned).toBe(0);
      expect(run?.error).toBe("permission denied for table powerbi_workspace");
    });
  });

  it("says a value Postgres refuses in Postgres's own words, without the query or its parameters", async () => {
    await withSync(sampleTenant(), async (tx, sync) => {
      // A CHECK the sample breaks, gone when the transaction rolls back.
      await tx.execute(sql`reset role`);
      await tx.execute(sql`set local role migrator`);
      await tx.execute(
        sql`alter table powerbi_workspace add constraint sync_error_test check (name not like 'Sales%') not valid`,
      );
      await setRole(tx, "worker_rw");
      await expect(sync()).rejects.toThrow();
      const run = await lastRun(tx);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain(
        'new row for relation "powerbi_workspace" violates check constraint "sync_error_test".',
      );
      expect(run?.error).not.toContain("insert into");
      expect(run?.error).not.toContain("params");
    });
  });
});

describe("storeWorkspace", () => {
  it("binds as many parameters to remove 500 measures as 50", async () => {
    const removalBinds = async (size: number) => {
      const binds: number[] = [];
      const logging = drizzle({
        client: testPool(TEST_RUNNER),
        schema,
        logger: {
          logQuery: (query, params) => {
            if (query.startsWith("update") && query.includes('"removed_at"'))
              binds.push(params.length);
          },
        },
      });
      await logging
        .transaction(async (tx) => {
          await setRole(tx, "worker_rw");
          const id = randomUUID();
          const scan = (count: number) => ({
            id,
            name: "Model",
            state: "active",
            datasets: [
              {
                id,
                name: "Model",
                tables: [
                  {
                    name: "T",
                    columns: [],
                    measures: Array.from({ length: count }, (_, at) => ({
                      name: `M${String(at)}`,
                      expression: "1",
                    })),
                  },
                ],
              },
            ],
          });
          await storeWorkspace(tx, scan(size), new Date(), true);
          await storeWorkspace(tx, scan(0), new Date(), true);
          const gone = await tx
            .select()
            .from(powerbiMeasure)
            .where(eq(powerbiMeasure.dataset_id, id));
          expect(gone).toHaveLength(size);
          expect(gone.every((row) => row.removed_at !== null)).toBe(true);
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      return binds;
    };
    const few = await removalBinds(50);
    expect(few).not.toEqual([]);
    expect(await removalBinds(500)).toEqual(few);
  });

  it("keeps a dataset's and a workspace's access rows when the scan gives no list", async () => {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const person = randomUUID();
      const entry = (principal_object_id: string) => ({
        principal_type: "user" as const,
        principal_object_id,
        email: null,
        access_right: "Viewer",
      });
      const workspace = { id: randomUUID(), name: "Model", state: "active" };
      const dataset = { id: randomUUID(), name: "Model" };
      const scan = (users?: ReturnType<typeof entry>[]) => ({
        ...workspace,
        users,
        datasets: [{ ...dataset, users }],
      });
      const rows = () =>
        tx
          .select()
          .from(powerbiAccess)
          .where(inArray(powerbiAccess.object_id, [workspace.id, dataset.id]));
      await storeWorkspace(tx, scan([entry(person)]), new Date(), true);
      expect(await rows()).toHaveLength(2);

      await storeWorkspace(tx, scan(undefined), new Date(), true);
      expect(await rows()).toHaveLength(2);

      await storeWorkspace(tx, scan([]), new Date(), true);
      expect(await rows()).toHaveLength(0);
    });
  });

  it.each(["A", "B"])(
    "matches renamed measures by the column table %s",
    async (table) => {
      await rolledBack(TEST_RUNNER, async (tx) => {
        await setRole(tx, "worker_rw");
        const workspace = { id: randomUUID(), name: "Model", state: "active" };
        const dataset = { id: randomUUID(), name: "Model" };
        const scan = (name: string, home: string) => ({
          ...workspace,
          datasets: [
            {
              ...dataset,
              tables: [
                {
                  name: "Sales",
                  measures: [{ name: "Units", expression: "SUM(C[Quantity])" }],
                },
                {
                  name: home,
                  measures: [{ name, expression: `SUM(${home}[Units])` }],
                },
              ],
            },
          ],
        });
        await storeWorkspace(tx, scan("Original", "A"), new Date(), true);
        const before = await tx
          .select()
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.dataset_id, dataset.id));
        const original = find(before, (m) => m.name === "Original");
        const stored = await storeWorkspace(
          tx,
          scan("Replacement", table),
          new Date(),
          true,
        );
        expect(stored.counts.renamed).toBe(table === "A" ? 1 : 0);
        const after = await tx
          .select()
          .from(powerbiMeasure)
          .where(eq(powerbiMeasure.dataset_id, dataset.id));
        const replacement = find(after, (m) => m.name === "Replacement");
        expect(replacement.id === original.id).toBe(table === "A");
      });
    },
  );

  it("stores relationships when a scan result carries them", async () => {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const key = { name: "Date key", dataType: "Int64" };
      const dataset = {
        id: randomUUID(),
        name: "Model",
        tables: [
          { name: "Sales", columns: [key] },
          { name: "Date", columns: [key] },
        ],
        relationships: [
          {
            fromTable: "Sales",
            fromColumn: "Date key",
            toTable: "Date",
            toColumn: "Date key",
            // Spelled the mirror's way already, as the scanner's schema hands it on.
            crossFilteringBehavior: "both_directions",
          },
        ],
      };
      const workspace = {
        id: randomUUID(),
        name: "Model",
        state: "active",
      };
      const scannedAt = new Date();
      await storeWorkspace(
        tx,
        { ...workspace, datasets: [dataset] },
        scannedAt,
        true,
      );

      const { dataset_id } = powerbiRelationship;
      const ends = await tx
        .select()
        .from(powerbiRelationship)
        .where(eq(dataset_id, dataset.id));
      expect(ends).toMatchObject([
        {
          from_table: "Sales",
          from_column: "Date key",
          to_table: "Date",
          to_column: "Date key",
          cross_filtering_behavior: "both_directions",
          removed_at: null,
        },
      ]);
      const [stored] = await tx
        .select()
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, dataset.id));
      expect(stored?.relationships_source).toBe("scanner");
      expect(stored?.relationships_read_at).toEqual(scannedAt);
      await storeWorkspace(
        tx,
        {
          ...workspace,
          datasets: [{ ...dataset, schemaRetrievalError: "unavailable" }],
        },
        new Date(scannedAt.getTime() + 60_000),
        true,
      );
      const [unread] = await tx
        .select()
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, dataset.id));
      expect(unread?.relationships_read_at).toEqual(scannedAt);
    });
  });

  it("starts a new dataset off when asked, and leaves an admin's choice alone", async () => {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const dataset = { id: randomUUID(), name: "Model" };
      const workspace = {
        id: randomUUID(),
        name: "Model",
        state: "active",
        datasets: [dataset],
      };
      const { id } = dataset;
      const enabled = async () => {
        const [row] = await tx
          .select({ enabled: powerbiDataset.enabled })
          .from(powerbiDataset)
          .where(eq(powerbiDataset.id, id));
        return row?.enabled;
      };

      await storeWorkspace(tx, workspace, new Date(), false);
      expect(await enabled()).toBe(false);

      await setRole(tx, "api_rw");
      await tx
        .update(powerbiDataset)
        .set({ enabled: true })
        .where(eq(powerbiDataset.id, id));
      await setRole(tx, "worker_rw");
      await storeWorkspace(tx, workspace, new Date(), false);
      expect(await enabled()).toBe(true);
    });
  });
});
