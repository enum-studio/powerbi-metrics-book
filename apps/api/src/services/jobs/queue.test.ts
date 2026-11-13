import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, testPool } from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import { jobRequest } from "../../db/schema/jobs.js";
import {
  enqueue,
  enqueueUnlessActive,
  finish,
  TAKEN_LOCK,
  take,
} from "./queue.js";

const api = createDb(testPool("api_rw"));
const MINE = ["check"] as const;

// Only the migrator may delete, and these rows are committed: take() is
// tested across connections, which a rolled-back transaction cannot show.
async function clearJobs(): Promise<void> {
  await createDb(testPool("migrator")).delete(jobRequest);
}

async function readJob(id: string) {
  const [job] = await api
    .select()
    .from(jobRequest)
    .where(eq(jobRequest.id, id));
  return job;
}

// Each session is a runner's own connection; ending it lets go of its locks.
const open = new Set<PoolClient>();
async function session(role: "api_rw" | "worker_rw" = "api_rw") {
  const client = await testPool(role).connect();
  open.add(client);
  return client;
}
/** Resolves once Postgres has ended the session, and with it its locks. */
function close(client: PoolClient): Promise<void> {
  open.delete(client);
  return new Promise((resolve) => {
    client.once("end", resolve);
    client.release(true);
  });
}

beforeEach(clearJobs);
afterEach(async () => {
  await Promise.all([...open].map(close));
});
afterAll(closeTestPools);

describe("take", () => {
  it("gives one queued job to exactly one of two takers on two connections", async () => {
    const id = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "manual",
    });
    const [first, second] = [await session(), await session()];
    // The row lock a taker holds until it commits. Skip locked passes over
    // it; without, the take would wait on it and the test time out.
    await first.query("begin");
    await first.query("select id from job_request where id = $1 for update", [
      id,
    ]);
    expect(await take(second, "api", MINE)).toBeNull();
    await first.query("commit");
    const taken = await Promise.all([
      take(first, "api", MINE),
      take(second, "api", MINE),
    ]);
    expect(taken.filter((job) => job !== null).map((job) => job.id)).toEqual([
      id,
    ]);
    expect(await readJob(id)).toMatchObject({ status: "running" });
  });

  it("takes the oldest queued job for its own runner and only the jobs it names", async () => {
    const first = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "schedule",
    });
    const second = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "manual",
      args: { full: true },
      requested_by: "test-admin",
    });
    expect(await take(await session("worker_rw"), "worker", MINE)).toBeNull();
    expect(await take(await session(), "api", ["embed"])).toBeNull();
    expect(await take(await session(), "api", MINE)).toMatchObject({
      id: first,
      job: "check",
      args: {},
    });
    expect(await take(await session(), "api", MINE)).toMatchObject({
      id: second,
      trigger: "manual",
      args: { full: true },
      requested_by: "test-admin",
    });
    expect(await take(await session(), "api", MINE)).toBeNull();
  });

  it("requeues a job whose runner's session ended mid-job, for another runner to take", async () => {
    const id = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "manual",
    });
    const [gone, next, last] = [
      await session(),
      await session(),
      await session(),
    ];
    expect(await take(gone, "api", MINE)).toMatchObject({ id });
    // While its runner's session lives, the job is that runner's alone.
    expect(await take(next, "api", MINE)).toBeNull();
    await close(gone);
    expect(await take(next, "api", MINE)).toMatchObject({
      id,
      status: "running",
    });
    // And now it is the next runner's alone.
    expect(await take(last, "api", MINE)).toBeNull();
    expect(await readJob(id)).toMatchObject({ status: "running" });
  });

  it("passes over a job whose lock key another session holds, rather than waiting for it", async () => {
    const held = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "schedule",
    });
    const next = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "manual",
    });
    // As a running job whose id shares held's hashtext value would.
    const holder = await session();
    await holder.query("select pg_advisory_lock(hashtext($1), hashtext($2))", [
      TAKEN_LOCK,
      held,
    ]);
    const started = performance.now();
    expect(await take(await session(), "api", MINE)).toMatchObject({
      id: next,
    });
    expect(await take(await session(), "api", MINE)).toBeNull();
    // A take that waited for the held lock would never return while it is held.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await readJob(held)).toMatchObject({
      status: "queued",
      taken_at: null,
    });
  });
});

describe("enqueueUnlessActive", () => {
  const check = (step: string) => ({
    job: "check" as const,
    runner: "worker" as const,
    args: { step },
    trigger: "manual" as const,
  });

  it("with sameArg, queues one request for each value, however many ask at once", async () => {
    const asked = await Promise.all(
      Array.from({ length: 5 }, () =>
        enqueueUnlessActive(api, check("scanner"), { sameArg: "step" }),
      ),
    );
    expect(asked.filter((each) => each.queued)).toHaveLength(1);
    expect(new Set(asked.map((each) => each.id)).size).toBe(1);
    const other = await enqueueUnlessActive(api, check("what_to_sync"), {
      sameArg: "step",
    });
    expect(other.queued).toBe(true);
    expect(other.id).not.toBe(asked[0]?.id);
  });

  it("with queuedOnly, queues one behind a running request, which then stands for the next", async () => {
    const first = await enqueueUnlessActive(api, check("scanner"), {
      sameArg: "step",
    });
    await api
      .update(jobRequest)
      .set({ status: "running", taken_at: new Date() })
      .where(eq(jobRequest.id, first.id));
    const behind = await enqueueUnlessActive(api, check("scanner"), {
      sameArg: "step",
      queuedOnly: true,
    });
    expect(behind.queued).toBe(true);
    expect(behind.id).not.toBe(first.id);
    expect(
      await enqueueUnlessActive(api, check("scanner"), {
        sameArg: "step",
        queuedOnly: true,
      }),
    ).toEqual({ id: behind.id, queued: false });
    // Without it the running request, the oldest, stands.
    expect(
      await enqueueUnlessActive(api, check("scanner"), { sameArg: "step" }),
    ).toEqual({ id: first.id, queued: false });
  });
});

describe("finish", () => {
  it("records the outcome and the time on a running job", async () => {
    const id = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "deploy",
    });
    const runner = await session();
    await take(runner, "api", MINE);
    await finish(runner, id, { status: "failed", error: "the token expired" });
    const job = await readJob(id);
    expect(job).toMatchObject({ status: "failed", error: "the token expired" });
    expect(job?.finished_at).toBeInstanceOf(Date);
  });

  it("refuses a job that is not running", async () => {
    const id = await enqueue(api, {
      job: "check",
      runner: "api",
      trigger: "manual",
    });
    await expect(
      finish(await session(), id, { status: "succeeded" }),
    ).rejects.toThrow(`job ${id} is not running`);
  });
});

describe("the job_request table", () => {
  it("refuses a job name the queue does not know", async () => {
    await expect(
      enqueue(api, {
        // @ts-expect-error: the database must refuse what the type would.
        job: "drop_everything",
        runner: "api",
        trigger: "manual",
      }),
    ).rejects.toMatchObject({ cause: { constraint: "job_request_job" } });
  });
});
