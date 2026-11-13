import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { Container, Db } from "../../context.js";
import {
  JOB_NAMES,
  type JobName,
  type JobTrigger,
  jobRequest,
} from "../../db/schema/jobs.js";

export { JOB_NAMES, type JobName } from "../../db/schema/jobs.js";

/**
 * The lock a runner holds on the id of the job it took, in the two-key space,
 * whose first key keeps it apart from the job-kind lock (runner.ts).
 */
export const TAKEN_LOCK = "powerbi_metrics_book.taken";

export type JobRequest = typeof jobRequest.$inferSelect;
export type Outcome =
  { status: "succeeded" } | { status: "failed" | "skipped"; error: string };

type NewJob = {
  job: JobName;
  runner: Container;
  args?: Record<string, unknown>;
  trigger: JobTrigger;
  requested_by?: string;
};

/** Queues a job for its runner to take; returns the request's id. */
export async function enqueue(db: Db, job: NewJob): Promise<string> {
  const [row] = await db
    .insert(jobRequest)
    .values({
      job: job.job,
      runner: job.runner,
      args: job.args ?? {},
      trigger: job.trigger,
      requested_by: job.requested_by ?? null,
    })
    .returning({ id: jobRequest.id });
  if (row === undefined) throw new Error(`no job_request row for ${job.job}`);
  return row.id;
}

/**
 * Queues the job unless a request of that job and runner is already queued,
 * and returns its id, or null when one was. The check and the insert are one
 * statement, so a burst of callers queues one request; two that race may queue
 * two, which the job lock runs one after the other, and the second finds
 * nothing left to do.
 *
 * A caller that finds a request queued relies on it to see the caller's own
 * work, which is not committed yet. If that request were taken, run and
 * finished first, the work would never be seen. So the request is selected
 * FOR SHARE and the caller holds the lock until it commits; take() selects
 * FOR UPDATE SKIP LOCKED, and passes the request over until then. Shared locks
 * do not block each other, so callers are not serialised. A request already
 * taken has left `queued` (the select waits for its taker and then skips it),
 * and the caller queues a new one.
 */
export async function enqueueUnlessQueued(
  db: Db,
  job: NewJob,
): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    with queued as (
      select id from job_request
      where job = ${job.job} and runner = ${job.runner} and status = 'queued'
      for share
    ), added as (
      insert into job_request (job, runner, args, trigger, requested_by)
      select ${job.job}, ${job.runner}, ${JSON.stringify(job.args ?? {})}::jsonb,
             ${job.trigger}, ${job.requested_by ?? null}
      where (select count(*) from queued) = 0
      returning id
    )
    select id from added`);
  return rows[0]?.id ?? null;
}

/** Serialises enqueueUnlessActive per job, in the two-key space, apart from the other locks here. */
const ACTIVE_LOCK = "powerbi_metrics_book.enqueue_active";

/**
 * Queues the job unless one of that job and runner is queued or running, and
 * answers the request that now stands for it, with whether this call queued
 * it. The insert and the look at what stands are one statement; the
 * transaction-scoped lock makes callers take turns, so a burst of callers
 * queues one request, where enqueueUnlessQueued may queue two.
 *
 * With `sameArg`, only a request whose args hold the same value under that
 * name stands for it: one job name that runs several things (the check job's
 * `step`) queues one request for each. With `queuedOnly`, a running request
 * does not stand for it, so work that changed what the running one already
 * read queues one more behind it. With `holdingArg`, only a request whose args
 * have that name stands for it, whatever its value: the sync job's `kind`, which
 * a request to draft one dataset does not have.
 */
export async function enqueueUnlessActive(
  db: Db,
  job: NewJob,
  {
    sameArg,
    queuedOnly = false,
    holdingArg,
  }: { sameArg?: string; queuedOnly?: boolean; holdingArg?: string } = {},
): Promise<{ id: string; queued: boolean }> {
  const standing = queuedOnly ? sql`('queued')` : sql`('queued', 'running')`;
  const value = sameArg === undefined ? undefined : job.args?.[sameArg];
  if (sameArg !== undefined && typeof value !== "string")
    throw new Error(`args.${sameArg} of ${job.job} is not a string`);
  const same =
    typeof value === "string" ? sql`and args->>${sameArg} = ${value}` : sql``;
  const holding =
    holdingArg === undefined
      ? sql``
      : sql`and args->>${holdingArg} is not null`;
  const key = typeof value === "string" ? `${job.job}:${value}` : job.job;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${ACTIVE_LOCK}), hashtext(${key}))`,
    );
    const { rows } = await tx.execute<{ id: string; queued: boolean }>(sql`
      with added as (
        insert into job_request (job, runner, args, trigger, requested_by)
        select ${job.job}, ${job.runner}, ${JSON.stringify(job.args ?? {})}::jsonb,
               ${job.trigger}, ${job.requested_by ?? null}
        where not exists (
          select 1 from job_request
          where job = ${job.job} and runner = ${job.runner}
            and status in ${standing} ${same} ${holding})
        returning id
      )
      select id, true as queued from added
      union all
      select id, false from (
        select id from job_request
        where job = ${job.job} and runner = ${job.runner}
          and status in ${standing} ${same} ${holding}
          and not exists (select 1 from added)
        order by requested_at limit 1) standing`);
    const [row] = rows;
    if (row === undefined) throw new Error(`no job_request row for ${job.job}`);
    return row;
  });
}

/**
 * Marks the oldest queued job for runner, among jobs, running and returns it;
 * null when there is none. session takes the job's lock and holds it until
 * the session ends, which is how every other taker knows the job's runner is
 * alive; so session is one connection, kept for as long as the job runs, and
 * takes one job: Postgres grants a session the locks it already holds, so a
 * second take on it would see its first job as abandoned.
 *
 * Skip locked lets two takers on two connections each get a different row,
 * or one of them none, rather than the same one. A job whose lock key another
 * session holds (two ids may share a hashtext value, and the requeue holds
 * one for a moment) is passed over, never waited for while this take holds
 * its row and its connection.
 */
export async function take(
  session: PoolClient,
  runner: Container,
  jobs: readonly JobName[] = JOB_NAMES,
): Promise<JobRequest | null> {
  if (jobs.length === 0) return null;
  const db = drizzle({ client: session });
  await requeueAbandoned(db, runner);
  const passed: string[] = [];
  for (;;) {
    // One transaction, so no other taker sees the job running before its
    // lock is held.
    const turn = await db.transaction(
      async (
        tx,
      ): Promise<{ taken: JobRequest | null } | { passed: string }> => {
        const [oldest] = await tx
          .select({ id: jobRequest.id })
          .from(jobRequest)
          .where(
            and(
              eq(jobRequest.status, "queued"),
              eq(jobRequest.runner, runner),
              inArray(jobRequest.job, [...jobs]),
              notInArray(jobRequest.id, passed),
            ),
          )
          .orderBy(asc(jobRequest.requested_at), asc(jobRequest.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (oldest === undefined) return { taken: null };
        const { rows } = await tx.execute<{ held: boolean }>(
          sql`select pg_try_advisory_lock(hashtext(${TAKEN_LOCK}), hashtext(${oldest.id})) as held`,
        );
        // Left queued, as it was: this transaction changed nothing.
        if (rows[0]?.held !== true) return { passed: oldest.id };
        const [taken] = await tx
          .update(jobRequest)
          .set({ status: "running", taken_at: sql`now()` })
          .where(eq(jobRequest.id, oldest.id))
          .returning();
        if (taken === undefined) throw new Error(`job ${oldest.id} vanished`);
        return { taken };
      },
    );
    if ("taken" in turn) return turn.taken;
    passed.push(turn.passed);
  }
}

/**
 * Requeues runner's running jobs whose lock is free: their runner stopped
 * mid-job (a deploy, a crash), and its session ended with it. The try lock is
 * the statement's own, let go when it ends. Skip locked passes over a job
 * another taker is marking running this moment, so this statement never
 * waits, and a taker waiting for its job's lock waits on it only briefly.
 */
async function requeueAbandoned(
  db: NodePgDatabase,
  runner: Container,
): Promise<void> {
  await db.execute(sql`
    with running as materialized (
      select id from ${jobRequest}
      where status = 'running' and runner = ${runner}
      for update skip locked
    )
    update ${jobRequest} set status = 'queued', taken_at = null
    from running
    where ${jobRequest.id} = running.id
      and pg_try_advisory_xact_lock(hashtext(${TAKEN_LOCK}), hashtext(running.id::text))`);
}

/** The names of the jobs queued for runner, each once. */
export async function queuedJobNames(
  db: Db,
  runner: Container,
): Promise<JobName[]> {
  const rows = await db
    .selectDistinct({ job: jobRequest.job })
    .from(jobRequest)
    .where(and(eq(jobRequest.status, "queued"), eq(jobRequest.runner, runner)));
  return rows.map((row) => row.job);
}

/**
 * Records how a job ended, on the session that took it: a runner whose
 * session ended has lost the job to the next taker, and fails here rather
 * than overwrite that taker's run.
 */
export async function finish(
  session: PoolClient,
  id: string,
  outcome: Outcome,
): Promise<void> {
  const finished = await drizzle({ client: session })
    .update(jobRequest)
    .set({
      status: outcome.status,
      error: outcome.status === "succeeded" ? null : outcome.error,
      finished_at: sql`now()`,
    })
    .where(and(eq(jobRequest.id, id), eq(jobRequest.status, "running")))
    .returning({ id: jobRequest.id });
  if (finished.length === 0) throw new Error(`job ${id} is not running`);
}

/** Returns a taken job its runner never started to the queue, as it was before. */
export async function putBack(session: PoolClient, id: string): Promise<void> {
  const queued = await drizzle({ client: session })
    .update(jobRequest)
    .set({ status: "queued", taken_at: null })
    .where(and(eq(jobRequest.id, id), eq(jobRequest.status, "running")))
    .returning({ id: jobRequest.id });
  if (queued.length === 0) throw new Error(`job ${id} is not running`);
}
