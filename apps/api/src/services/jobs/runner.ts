import type { PoolClient } from "pg";
import type { AppDeps, Container } from "../../context.js";
import { errorSentence, storable } from "../../http/error-log.js";
import {
  finish,
  JOB_NAMES,
  type JobName,
  type JobRequest,
  type Outcome,
  putBack,
  queuedJobNames,
  take,
} from "./queue.js";
import { refuseDemoOffTheSample } from "../demo/locks.js";
import { refuseAnotherTenant } from "../setup/tenant.js";
import { handlerFor, type RegisteredJob } from "./registry.js";

const IDLE_MS = 1000;
const LOCK_POLL_MS = 250;
const HEARTBEAT_MS = 10_000;
/** Room for a sync's stored error, which says at most 20 sentences. */
const JOB_ERROR_CHARACTERS = 16_000;
// The first key of every job's two-key advisory lock; the second is the job's
// name. Two-key locks never collide with the migration's one-key lock.
const JOB_LOCK = "powerbi_metrics_book.job";

export type RunJobsOptions = {
  signal: AbortSignal;
  /**
   * Called on every turn of the loop, about once a second while the queue is
   * empty, and every 10 seconds while a job waits or runs. The worker's entry
   * touches /tmp/worker-heartbeat here, which its health check reads.
   */
  heartbeat?: () => void;
};

/**
 * Takes this container's jobs one at a time until signal aborts, then
 * returns once the job in hand has finished. A job whose name has no handler
 * in this container stays queued, for a later version that has one.
 */
export async function runJobs(
  deps: AppDeps,
  { signal, heartbeat = () => {} }: RunJobsOptions,
): Promise<void> {
  const mine = JOB_NAMES.filter(
    (name) => handlerFor(name, deps.container) !== undefined,
  );
  const reported = new Set<JobName>();
  while (!signal.aborted) {
    heartbeat();
    // The job's session: it holds the job's locks for as long as the job
    // runs, and lets go of them when it ends, also when the container dies
    // mid-job, so the next runner to take sees the job abandoned.
    const session = await deps.pool.connect();
    const watch = watchSession(session);
    const job = await Promise.race([
      take(session, deps.container, mine),
      watch.ended,
    ]).catch((error: unknown) => {
      session.release(true);
      throw error;
    });
    if (job === null) {
      // Holds no lock when it took nothing, so it may go back to the pool.
      watch.stop();
      session.release();
      for (const name of await queuedJobNames(deps.db, deps.container)) {
        if (mine.includes(name) || reported.has(name)) continue;
        reported.add(name);
        deps.logger.warn("queued jobs wait: no handler in this container", {
          job: name,
          container: deps.container,
        });
      }
      await pause(IDLE_MS, signal);
      continue;
    }
    // Without its session the job's locks are gone, and another runner may
    // take it. So the runner stops at once, rather than run on without them:
    // its entry exits, the handler with it, and the container restarts.
    const ended = watch.ended.catch((error: unknown) => {
      deps.logger.error("the job's session ended; the runner stops", {
        job: job.job,
        id: job.id,
      });
      throw new Error(`the session of job ${job.id} ended`, { cause: error });
    });
    const beating = setInterval(heartbeat, HEARTBEAT_MS);
    try {
      await Promise.race([runOne(session, deps, job, signal), ended]);
    } finally {
      clearInterval(beating);
      // Destroyed rather than returned to the pool, which ends the session and
      // lets go of its locks.
      session.release(true);
    }
  }
}

/**
 * This container's handler for a job it took. A job queued for the other
 * container is never run here, whatever handler this one has for its name:
 * the check job has one in each, and only the worker's reads the scanner's
 * secret.
 */
export function handlerHere(
  container: Container,
  job: Pick<JobRequest, "id" | "job" | "runner">,
): RegisteredJob {
  if (job.runner !== container)
    throw new Error(
      `took ${job.job} (${job.id}), which is queued for the ${job.runner}, in the ${container}`,
    );
  const registered = handlerFor(job.job, container);
  if (registered === undefined)
    throw new Error(`took ${job.job} (${job.id}), which has no handler`);
  return registered;
}

async function runOne(
  session: PoolClient,
  deps: AppDeps,
  job: JobRequest,
  signal: AbortSignal,
): Promise<void> {
  const registered = handlerHere(deps.container, job);
  // Per container, so the api's check job can wait on the worker's.
  const wait = await waitForLock(
    session,
    `${deps.container} ${job.job}`,
    registered.max_wait_ms,
    signal,
  );
  if (wait === "stopped") {
    // A deploy stops the runner: the job goes to the next one, not lost.
    await putBack(session, job.id);
    deps.logger.info("job returned to the queue", {
      job: job.job,
      id: job.id,
    });
    return;
  }
  const seconds = Math.round(registered.max_wait_ms / 100) / 10;
  const outcome: Outcome =
    wait === "timed_out"
      ? {
          status: "skipped",
          error: `another ${job.job} held the lock for all of ${String(seconds)} seconds`,
        }
      : await runHandler(deps, job, registered);
  await finish(session, job.id, outcome);
  deps.logger.info("job finished", {
    job: job.job,
    id: job.id,
    status: outcome.status,
    error: outcome.status === "succeeded" ? null : outcome.error,
  });
}

async function runHandler(
  deps: AppDeps,
  job: JobRequest,
  registered: RegisteredJob,
): Promise<Outcome> {
  try {
    // A worker that started before the setup bound the tenant is checked
    // here, before each job of any kind.
    await refuseAnotherTenant(deps);
    await refuseDemoOffTheSample(deps);
    await registered.handler(deps, job.args, job.trigger);
    return { status: "succeeded" };
  } catch (error) {
    // The message only: a stack names files and lines, which the admin
    // section has no use for.
    return {
      status: "failed",
      error: storable(errorSentence(error), JOB_ERROR_CHARACTERS),
    };
  }
}

async function waitForLock(
  session: PoolClient,
  name: string,
  maxWaitMs: number,
  signal: AbortSignal,
): Promise<"held" | "timed_out" | "stopped"> {
  const deadline = performance.now() + maxWaitMs;
  for (;;) {
    const { rows } = await session.query<{ held: boolean }>(
      "select pg_try_advisory_lock(hashtext($1), hashtext($2)) as held",
      [JOB_LOCK, name],
    );
    if (rows[0]?.held === true) return "held";
    if (signal.aborted) return "stopped";
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "timed_out";
    await pause(Math.min(LOCK_POLL_MS, remaining), signal);
  }
}

/**
 * ended rejects once Postgres ends session (a restart, pg_terminate_backend),
 * which lets go of its locks; unheard, the client's error would be thrown
 * uncaught. stop() stops listening, before the session goes back to the pool.
 */
function watchSession(session: PoolClient): {
  ended: Promise<never>;
  stop(): void;
} {
  let onError: (error: Error) => void = () => {};
  const ended = new Promise<never>((_, reject) => {
    onError = reject;
  });
  session.on("error", onError);
  return { ended, stop: () => session.off("error", onError) };
}

/** Resolves after ms, or at once when signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
