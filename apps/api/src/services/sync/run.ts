import { and, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { chosenBySettings } from "./selection.js";
import type { AppDeps } from "../../context.js";
import {
  powerbiDataset,
  powerbiWorkspace,
  SYNC_KINDS,
  type SYNC_TRIGGERS,
  syncRun,
} from "../../db/schema/mirror.js";
import { chunks } from "../../db/statements.js";
import { ServiceError } from "../../errors.js";
import { errorSentence, logError, storable } from "../../http/error-log.js";
import {
  mayBeOneWorkspace,
  modifiedWorkspaces,
  scanResult,
  startScan,
  waitForScan,
} from "../../powerbi/scanner.js";
import { scannerSetUp } from "../../powerbi/identity.js";
import { draftDatasets, removedDatasetsInDrafts } from "../book/drafter.js";
import { withEvents } from "../events/feed.js";
import { enqueue } from "../jobs/queue.js";
import { registerJob } from "../jobs/registry.js";
import { accessWithoutRight, unsentLists } from "./access-lists.js";
import { type AppScan, syncApps } from "./apps.js";
import {
  refusedByPostgres,
  removeWorkspaces,
  type Stored,
  storeWorkspace,
} from "./store.js";

/*
 * The sync: which workspaces changed, their scans, the mirror, the apps,
 * then drafts and embeddings. The job runner's lock on the job's name keeps
 * it to one at a time.
 */

export type SyncKind = (typeof SYNC_KINDS)[number];
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];
export type SyncOutcome = {
  id: string;
  /** Full when an incremental sync had no recent enough start to go from. */
  kind: SyncKind;
  status: "succeeded" | "skipped";
  counts: Record<string, number>;
};

const WORKSPACES_PER_SCAN = 100;
const SCANS_IN_FLIGHT = 4;
/**
 * What narrowing failed scans may spend in one run, of Microsoft's 500 scans
 * an hour. One workspace at fault among 100 costs about 14.
 */
const SCANS_TO_NARROW = 300;
/** Sentences a run's stored error holds; its counts say how many in all. */
const PROBLEMS_SAID = 20;
const PROBLEM_CHARACTERS = 500;
const SKIP_A_WORKSPACE =
  "To leave out what fails on every sync, put its workspace under Workspaces to skip in the admin section: the next full sync then removes that whole workspace from the mirror.";
/** The counts of what its own workspace may be at fault for, whose sentences name an id that setting can take. */
const NAMES_A_WORKSPACE = [
  "workspaces_failed",
  "datasets_failed",
  "apps_failed",
];
const MINUTE_MS = 60_000;
/** Microsoft's bounds on modifiedSince. */
const SINCE_MIN_MS = 30 * MINUTE_MS;
const SINCE_MAX_MS = 30 * 24 * 60 * MINUTE_MS;

/** A Power BI call's ServiceError as a value, so one batch failing leaves the others going. */
async function attempt<T>(work: () => Promise<T>): Promise<T | ServiceError> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
}

/**
 * Whether a deploy's or the schedule's sync may run: once a person has started
 * one. setup.completed_at is no earlier sign of that, as it is set only after
 * the first sync has passed; a run that was not skipped is, and it also keeps
 * the schedule retrying after a first sync that failed.
 */
export async function syncStarted(deps: AppDeps): Promise<boolean> {
  if ((await deps.settings.get("setup.completed_at")) !== null) return true;
  const [run] = await deps.db
    .select({ id: syncRun.id })
    .from(syncRun)
    .where(ne(syncRun.status, "skipped"))
    .limit(1);
  return run !== undefined;
}

/**
 * Records a sync_run, and throws once it is recorded as failed. Power BI's
 * modifiedSince must be 30 minutes to 30 days old: an incremental sync
 * sooner after the last successful one is skipped, one later becomes full.
 */
export async function runSync(
  deps: AppDeps,
  options: { kind: SyncKind; trigger: SyncTrigger; poll_ms?: number },
): Promise<SyncOutcome> {
  const { trigger } = options;
  const now = deps.clock();
  let kind = options.kind;
  let since: Date | null = null;
  let skipped: string | null = null;
  // The worker's deploy sync runs before anyone has set up the scanner.
  if (!(await scannerSetUp(deps)))
    skipped =
      "The scanner is not set up yet, so there is nothing to sync. The setup's scanner step sets it up.";
  else if (trigger !== "manual" && !(await syncStarted(deps)))
    skipped =
      "The setup has not started the first sync yet, so this sync is skipped. The setup's What to sync step starts it.";
  else if (kind === "incremental") {
    const [last] = await deps.db
      .select({ started_at: syncRun.started_at })
      .from(syncRun)
      .where(eq(syncRun.status, "succeeded"))
      .orderBy(desc(syncRun.started_at))
      .limit(1);
    const age = last ? now.getTime() - last.started_at.getTime() : Infinity;
    if (age < SINCE_MIN_MS) {
      const minutes = String(Math.floor(age / MINUTE_MS));
      skipped = `The last successful sync started ${minutes} minutes ago, and Power BI lists changes from 30 minutes back at the soonest.`;
    } else if (last && age <= SINCE_MAX_MS) since = last.started_at;
    else kind = "full";
  }

  const [row] = await deps.db
    .insert(syncRun)
    .values({
      kind,
      trigger,
      started_at: now,
      status: skipped === null ? "running" : "skipped",
      finished_at: skipped === null ? null : now,
      error: skipped,
    })
    .returning({ id: syncRun.id });
  if (row === undefined) throw new Error("no sync_run row");
  if (skipped !== null)
    return { id: row.id, kind, status: "skipped", counts: {} };
  const run = { id: row.id, kind, trigger };
  const counts: Record<string, number> = {
    workspaces_scanned: 0,
    access_lists_unsent: 0,
  };
  const problems: string[] = [];
  try {
    const plan = { kind, trigger, since, now, poll_ms: options.poll_ms };
    await sync(deps, plan, counts, problems);
  } catch (error) {
    await finish(
      deps,
      run,
      counts,
      said([errorSentence(error), ...problems], counts),
    );
    throw error;
  }
  if (problems.length > 0) {
    const sentence = said(problems, counts);
    await finish(deps, run, counts, sentence);
    throw new ServiceError("upstream", sentence);
  }
  await finish(deps, run, counts, null);
  return { id: run.id, kind, status: "succeeded", counts };
}

function said(
  problems: readonly string[],
  counts: Record<string, number>,
): string {
  const more = problems.length - PROBLEMS_SAID;
  return [
    ...problems
      .slice(0, PROBLEMS_SAID)
      .map((problem) => storable(problem, PROBLEM_CHARACTERS)),
    ...(more > 0 ? [`And ${String(more)} more.`] : []),
    ...(NAMES_A_WORKSPACE.some((key) => counts[key] !== undefined)
      ? [SKIP_A_WORKSPACE]
      : []),
  ].join(" ");
}

async function sync(
  deps: AppDeps,
  plan: {
    kind: SyncKind;
    trigger: SyncTrigger;
    since: Date | null;
    now: Date;
    poll_ms?: number;
  },
  counts: Record<string, number>,
  problems: string[],
): Promise<void> {
  const add = (key: string, n: number) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  const newDatasetsEnabled =
    (await deps.settings.get("powerbi.datasets.new")) === "on";
  const listed = await chosen(deps, plan.since);
  const failed = new Set<string>();
  const reports: AppScan["reports"][number][] = [];
  const drafts = new Set<string>();
  const batches = chunks(listed, WORKSPACES_PER_SCAN);
  let spare = SCANS_TO_NARROW;

  while (batches.length > 0) {
    const window = batches.splice(0, SCANS_IN_FLIGHT);
    // Started one after another, so a scan's place in the queue is its batch's.
    const started: (string | ServiceError)[] = [];
    for (const batch of window)
      started.push(await attempt(() => startScan(deps, batch)));
    const scans = await Promise.all(
      started.map((scan) =>
        typeof scan === "string"
          ? attempt(async () => {
              await waitForScan(deps, scan, { poll_ms: plan.poll_ms });
              return scan;
            })
          : Promise.resolve(scan),
      ),
    );
    // One answer in memory at a time, each up to 32 MiB of what a model wrote:
    // a window's four together could run the worker out of memory.
    for (const [n, scan] of scans.entries()) {
      const batch = window[n] ?? [];
      const result =
        typeof scan === "string"
          ? await attempt(() => scanResult(deps, scan))
          : scan;
      if (result instanceof ServiceError) {
        if (batch.length > 1 && spare >= 2 && mayBeOneWorkspace(result)) {
          // Each half goes next, until the workspace at fault stands alone.
          const half = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(0, half), batch.slice(half));
          spare -= 2;
          continue;
        }
        for (const id of batch) failed.add(id);
        deps.logger.error("A scan failed.", {
          workspaces: batch.join(","),
          reason: storable(result.message, PROBLEM_CHARACTERS),
        });
        // A 5xx on a scan of one workspace still says nothing of that workspace.
        add(
          batch.length === 1 && mayBeOneWorkspace(result)
            ? "workspaces_failed"
            : "batches_failed",
          1,
        );
        const [only] = batch;
        problems.push(
          only !== undefined && batch.length === 1
            ? `Workspace ${only} could not be scanned, so it was left as it was. ${result.message}`
            : `A scan of ${String(batch.length)} workspaces failed, so they were left as they were, and the worker's log names them. ${result.message}`,
        );
        continue;
      }
      // One workspace's transaction at a time: they share one database handle.
      for (const workspace of result.workspaces) {
        let stored: Stored;
        try {
          stored = await storeWorkspace(
            deps.db,
            workspace,
            plan.now,
            newDatasetsEnabled,
          );
        } catch (error) {
          const reason = refusedByPostgres(error);
          if (reason === null) throw error;
          logError(deps.logger, "A workspace could not be stored.", error, {
            request_id: null,
            workspace_id: workspace.id,
          });
          failed.add(workspace.id);
          add("workspaces_failed", 1);
          problems.push(
            `Workspace ${workspace.id} could not be stored, so it was left as it was. ${reason}`,
          );
          continue;
        }
        for (const { id, reason, error } of stored.failed_datasets) {
          logError(deps.logger, "A dataset could not be stored.", error, {
            request_id: null,
            dataset_id: id,
          });
          add("datasets_failed", 1);
          problems.push(
            `Dataset ${id} in workspace ${workspace.id} could not be stored, so it was left as it was. ${reason}`,
          );
        }
        for (const id of stored.changed_datasets) drafts.add(id);
        for (const [key, count] of Object.entries(stored.counts))
          add(`items_${key}`, count);
        add("workspaces_scanned", 1);
        add("access_lists_unsent", unsentLists(workspace));
        // The links alone outlive this answer, not what a report's name holds.
        for (const { appId, datasetId } of workspace.reports ?? [])
          if (appId !== undefined && datasetId !== undefined)
            reports.push({ appId, datasetId });
      }
    }
  }

  if (plan.kind === "full") {
    const unlisted = await deps.db
      .select({ id: powerbiWorkspace.id })
      .from(powerbiWorkspace)
      .where(
        and(
          isNull(powerbiWorkspace.removed_at),
          notInArray(powerbiWorkspace.id, listed),
        ),
      );
    const ids = unlisted.map((w) => w.id);
    const gone = await deps.db.transaction((tx) =>
      removeWorkspaces(tx, ids, plan.now),
    );
    for (const id of gone) drafts.add(id);
    add("workspaces_removed", ids.length);
  }
  // The mirror above is stored either way, and the drafts and embeddings below
  // do not read the apps, so apps that cannot be read wait for the next sync.
  const appsFailed = new Set<string>();
  try {
    add(
      "apps",
      await syncApps(
        deps,
        { full: plan.kind === "full", reports, failed, now: plan.now },
        ({ id, sentence, error }) => {
          logError(deps.logger, "An app could not be synced.", error, {
            request_id: null,
            app_id: id,
          });
          // Its audience and its row can both fail: two sentences, one app.
          appsFailed.add(id);
          counts.apps_failed = appsFailed.size;
          problems.push(sentence);
        },
      ),
    );
  } catch (error) {
    const reason =
      error instanceof ServiceError ? error.message : refusedByPostgres(error);
    if (reason === null) throw error;
    logError(deps.logger, "The apps could not be synced.", error, {
      request_id: null,
    });
    add("apps_not_synced", 1);
    problems.push(
      `The apps could not be synced, so they may be out of date. ${reason}`,
    );
  }
  add("access_without_right", await accessWithoutRight(deps.db));
  add("datasets_changed", drafts.size);
  // Every dataset that is on, not only the changed: the conventions and the
  // drafter's own rules change too, and a run with nothing to do writes nothing.
  // One turned off is read again only when it changes, as an admin can stop a
  // crafted one this way.
  const on = await deps.db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(
      and(isNull(powerbiDataset.removed_at), eq(powerbiDataset.enabled, true)),
    );
  const drafted = await draftDatasets(deps, [
    ...new Set([
      ...drafts,
      ...on.map((dataset) => dataset.id),
      ...(await removedDatasetsInDrafts(deps.db)),
    ]),
  ]);
  const { failed_datasets, ...draftCounts } = drafted;
  for (const [key, count] of Object.entries(draftCounts))
    add(`drafts_${key}`, count);
  for (const id of failed_datasets)
    problems.push(
      `Dataset ${id} could not be drafted, so its drafts were left as they were. The worker's log says why.`,
    );
  // The embed job finds what changed by each document's hash.
  await enqueue(deps.db, {
    job: "embed",
    runner: "worker",
    trigger: plan.trigger,
  });
}

/** The workspaces Power BI lists, as the settings narrow them. */
async function chosen(deps: AppDeps, since: Date | null): Promise<string[]> {
  const isChosen = await chosenBySettings(deps);
  const listed = await modifiedWorkspaces(deps, { since });
  return listed.filter(isChosen);
}

async function finish(
  deps: AppDeps,
  run: { id: string; kind: SyncKind; trigger: SyncTrigger },
  counts: Record<string, number>,
  error: string | null,
): Promise<void> {
  await withEvents(deps.db, async (tx, emit) => {
    await tx
      .update(syncRun)
      .set({
        status: error === null ? "succeeded" : "failed",
        finished_at: deps.clock(),
        workspaces_scanned: counts.workspaces_scanned ?? 0,
        counts,
        error,
      })
      .where(eq(syncRun.id, run.id));
    emit({
      kind: error === null ? "sync.finished" : "sync.failed",
      element_kind: null,
      element_id: null,
      principal: null,
      data: {
        sync_run_id: run.id,
        kind: run.kind,
        trigger: run.trigger,
        counts,
        ...(error === null ? {} : { error }),
      },
    });
  });
}

const jobParameters = z.union([
  z.object({ kind: z.enum(SYNC_KINDS) }),
  z.object({ draft_dataset: z.string() }),
]);

/**
 * Drafts one dataset an admin turned on, with no scan: a sync soon after another
 * returns before it drafts, and Power BI has nothing new to say. One turned off
 * again is left alone, as the switch is how an admin stops a crafted model.
 */
async function draftDatasetTurnedOn(deps: AppDeps, id: string): Promise<void> {
  const [on] = await deps.db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(
      and(
        eq(powerbiDataset.id, id),
        eq(powerbiDataset.enabled, true),
        isNull(powerbiDataset.removed_at),
      ),
    );
  if (on === undefined) return;
  const { failed } = await draftDatasets(deps, [id]);
  if (failed > 0) throw new Error(`The dataset ${id} could not be drafted.`);
}

registerJob("sync", "worker", async (deps, parameters, trigger) => {
  const parsed = jobParameters.safeParse(parameters);
  if (!parsed.success)
    throw new Error(
      `A sync job's parameters name its kind, "incremental" or "full", or a dataset to draft, not ${JSON.stringify(parameters)}.`,
    );
  if ("draft_dataset" in parsed.data)
    await draftDatasetTurnedOn(deps, parsed.data.draft_dataset);
  else await runSync(deps, { kind: parsed.data.kind, trigger });
});
