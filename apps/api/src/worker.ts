import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { AppDeps } from "./context.js";
import { buildDeps } from "./deps.js";
import { enqueue } from "./services/jobs/queue.js";
import { runJobs } from "./services/jobs/runner.js";
import { refuseDemoOffTheSample } from "./services/demo/locks.js";
import { refuseAnotherTenant } from "./services/setup/tenant.js";
import { type ScheduleEntry, startSchedule } from "./services/jobs/schedule.js";
import type { Environment } from "./services/settings/env.js";
// Loaded for its side effect: it imports every module that registers a job.
import "./services/jobs/all.js";

/** What the worker's health check in stack/compose.yml reads: the file's age must stay under 90 seconds. */
const HEARTBEAT_FILE = "/tmp/worker-heartbeat";

function scheduleEntries(): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [
    {
      job: "sync",
      runner: "worker",
      args: { kind: "incremental" },
      cron: { setting: "powerbi.sync.schedule" },
    },
    {
      job: "sync",
      runner: "worker",
      args: { kind: "full" },
      cron: { setting: "powerbi.sync.full_scan_schedule" },
    },
    // The api takes it, and returns at once unless
    // powerbi.keep_connections_alive_days is set.
    { job: "refresh_idle_connections", runner: "api", cron: "0 3 * * *" },
    { job: "expire_results", runner: "worker", cron: "*/15 * * * *" },
    { job: "expire_usage", runner: "worker", cron: "15 4 * * *" },
    { job: "check", runner: "api", cron: "30 3 * * *" },
  ];
  return entries;
}

/**
 * The worker's whole life: queues a sync for this deploy, keeps the
 * schedule, and takes the worker's jobs until signal aborts. Rejects when a
 * job's session ends, so the container exits and restarts.
 */
export async function runWorker(
  deps: AppDeps,
  options: { signal: AbortSignal; heartbeat_file?: string },
): Promise<void> {
  const { signal, heartbeat_file = HEARTBEAT_FILE } = options;
  const schedule = await startSchedule(deps, scheduleEntries());
  try {
    // Incremental falls back to a full sync when there is no earlier one.
    await enqueue(deps.db, {
      job: "sync",
      runner: "worker",
      args: { kind: "incremental" },
      trigger: "deploy",
    });
    deps.logger.info("worker started", { git_sha: deps.config.git_sha });
    await runJobs(deps, {
      signal,
      heartbeat: () => {
        writeFileSync(heartbeat_file, String(deps.clock().getTime()));
      },
    });
  } finally {
    schedule.stop();
  }
}

/** The `worker` command. */
export async function startWorker(
  env: Environment,
  signal: AbortSignal,
): Promise<void> {
  const deps = await buildDeps(loadConfig(env, "worker"), env);
  try {
    await refuseAnotherTenant(deps);
    await refuseDemoOffTheSample(deps);
    await runWorker(deps, { signal });
    deps.logger.info("worker stopped");
  } finally {
    await deps.close();
  }
}
