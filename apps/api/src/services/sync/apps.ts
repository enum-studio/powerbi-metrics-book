import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { AppDeps, Db } from "../../context.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiDataset,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import {
  type AccessEntry,
  appUsers,
  listApps,
  listReports,
  mayBeOneApp,
  type PowerBiApp,
} from "../../powerbi/admin.js";
import { dropAccess, replaceAccess } from "./access-lists.js";
import { refusedByPostgres, upsert } from "./store.js";

type ReportLink = { appId?: string; datasetId?: string };

export type AppScan = {
  full: boolean;
  /** What ties the reports of every workspace this sync stored to their apps. */
  reports: readonly ReportLink[];
  /** Workspaces whose scan failed: what their apps show stays as it was. */
  failed: ReadonlySet<string>;
  now: Date;
};

/** What was left of one app, what to say of it, and what stopped it. */
export type FailedApp = { id: string; sentence: string; error: unknown };

/**
 * Every app, from Power BI's list, with the datasets behind its reports and,
 * on a full sync, its audience. An app whose reports the scan did not show
 * keeps its datasets, except on a full sync, which asks admin/reports.
 * Answers how many apps it read; each that fails is told to `appFailed` at
 * once, so the run can name it even if a later one ends the run.
 */
export async function syncApps(
  deps: AppDeps,
  scan: AppScan,
  appFailed: (app: FailedApp) => void,
): Promise<number> {
  const listed = await listApps(deps);
  const live = await deps.db
    .select({ id: powerbiWorkspace.id })
    .from(powerbiWorkspace)
    .where(
      and(
        isNull(powerbiWorkspace.removed_at),
        inArray(
          powerbiWorkspace.id,
          listed.map((app) => app.workspaceId),
        ),
      ),
    );
  const mirrored = new Set(live.map((row) => row.id));
  // An app in a workspace the sync leaves out has nowhere to hang.
  const apps = listed.filter((app) => mirrored.has(app.workspaceId));

  const shown = datasetsByApp(scan.reports);
  const datasets = new Map<string, Set<string>>();
  const uncovered = [];
  for (const app of apps) {
    const fromScan = shown.get(app.id);
    if (fromScan !== undefined) datasets.set(app.id, fromScan);
    else if (scan.full && !scan.failed.has(app.workspaceId))
      uncovered.push(app.id);
  }
  if (uncovered.length > 0) {
    // One listing for all of them: admin/reports allows 5 calls a minute.
    const reports = datasetsByApp(await listReports(deps));
    for (const id of uncovered) datasets.set(id, reports.get(id) ?? new Set());
  }
  const audiences = new Map<string, AccessEntry[]>();
  if (scan.full)
    for (const app of apps) {
      try {
        audiences.set(app.id, await appUsers(deps, app.id));
      } catch (error) {
        if (!(error instanceof ServiceError && mayBeOneApp(error))) throw error;
        appFailed({
          id: app.id,
          sentence: `The audience of app ${app.id} in workspace ${app.workspaceId} could not be read, so it was left as it was. ${error.message}`,
          error,
        });
      }
    }

  for (const app of apps) {
    try {
      // Its own transaction, so an app that cannot be stored costs itself alone.
      await deps.db.transaction((tx) =>
        storeApp(
          tx,
          app,
          datasets.get(app.id),
          audiences.get(app.id),
          scan.now,
        ),
      );
    } catch (error) {
      const reason = refusedByPostgres(error);
      if (reason === null) throw error;
      appFailed({
        id: app.id,
        sentence: `App ${app.id} in workspace ${app.workspaceId} could not be stored, so it was left as it was. ${reason}`,
        error,
      });
    }
  }
  await deps.db.transaction(async (tx) => {
    const { id, removed_at } = powerbiApp;
    const gone = await tx
      .update(powerbiApp)
      .set({ removed_at: scan.now })
      .where(
        and(
          isNull(removed_at),
          notInArray(
            id,
            apps.map((app) => app.id),
          ),
        ),
      )
      .returning({ id });
    await dropAccess(
      tx,
      "app",
      gone.map((app) => app.id),
    );
  });
  return apps.length;
}

/** One app; datasets or an audience the sync did not read stay as they were. */
async function storeApp(
  tx: Db,
  app: PowerBiApp,
  datasets: ReadonlySet<string> | undefined,
  audience: readonly AccessEntry[] | undefined,
  now: Date,
): Promise<void> {
  const row = {
    id: app.id,
    name: app.name,
    description_pbi: app.description ?? null,
    workspace_id: app.workspaceId,
    published_by: app.publishedBy ?? null,
    last_update: app.lastUpdate ? new Date(app.lastUpdate) : null,
    synced_at: now,
    removed_at: null,
  };
  const { id } = powerbiApp;
  await upsert([row], [id], (part, set) =>
    tx.insert(powerbiApp).values(part).onConflictDoUpdate({ target: id, set }),
  );
  if (datasets !== undefined) {
    await tx
      .delete(powerbiAppDataset)
      .where(eq(powerbiAppDataset.app_id, app.id));
    // A report may sit on a dataset in a workspace the sync leaves out.
    const stored = await tx
      .select({ id: powerbiDataset.id })
      .from(powerbiDataset)
      .where(inArray(powerbiDataset.id, [...datasets]));
    if (stored.length > 0)
      await tx.insert(powerbiAppDataset).values(
        stored.map((dataset) => ({
          app_id: app.id,
          dataset_id: dataset.id,
        })),
      );
  }
  await replaceAccess(tx, "app", new Map([[app.id, audience]]), now);
}

function datasetsByApp(
  reports: readonly ReportLink[],
): Map<string, Set<string>> {
  const byApp = new Map<string, Set<string>>();
  for (const { appId, datasetId } of reports) {
    if (appId === undefined || datasetId === undefined) continue;
    byApp.set(appId, (byApp.get(appId) ?? new Set()).add(datasetId));
  }
  return byApp;
}
