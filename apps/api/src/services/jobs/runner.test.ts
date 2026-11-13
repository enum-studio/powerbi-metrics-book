import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testPool,
} from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { createLogger } from "../../log.js";
import { enqueue, TAKEN_LOCK } from "./queue.js";
import { registerJob } from "./registry.js";
import { handlerHere, runJobs } from "./runner.js";

const refuseDemo = vi.hoisted(() => vi.fn());
vi.mock("../demo/locks.js", () => ({ refuseDemoOffTheSample: refuseDemo }));

const db = createDb(testPool("worker_rw"));

// sync and refresh_idle_connections run until the test lets them go.
const blocked: (() => void)[] = [];
const block = () =>
  new Promise<void>((resolve) => {
    blocked.push(resolve);
  });
function releaseBlocked(): void {
  for (const resolve of blocked.splice(0)) resolve();
}
registerJob("sync", "worker", block, { max_wait_ms: 300 });
registerJob("refresh_idle_connections", "worker", block, {
  max_wait_ms: 60_000,
});
// check runs until let go too, and counts its runs and how many overlap.
const checks = { runs: 0, running: 0, most: 0 };
registerJob("check", "worker", async () => {
  checks.runs += 1;
  checks.running += 1;
  checks.most = Math.max(checks.most, checks.running);
  try {
    await block();
  } finally {
    checks.running -= 1;
  }
});
registerJob("embed", "worker", () =>
  Promise.reject(new Error("the embedding provider refused the key")),
);
const expired: { parameters: Record<string, unknown>; trigger: string }[] = [];
registerJob("expire_results", "worker", (_deps, parameters, trigger) => {
  expired.push({ parameters, trigger });
  return Promise.resolve();
});

// Only the migrator may delete; these rows are committed, because the
// runners see each other's work across connections.
async function clearJobs(): Promise<void> {
  await createDb(testPool("migrator")).delete(jobRequest);
}

async function readJob(id: string) {
  const [job] = await db.select().from(jobRequest).where(eq(jobRequest.id, id));
  if (job === undefined) throw new Error(`no job ${id}`);
  return job;
}

async function until(id: string, status: string) {
  // Generous: a loaded run is slow, and a job that never gets there still fails.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await readJob(id);
    if (job.status === status) return job;
    if (Date.now() > deadline)
      throw new Error(`job ${id} is ${job.status}, not ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const running: { stop: AbortController; done: Promise<void> }[] = [];
function startRunner(log: string[] = [], beats = { count: 0 }) {
  const stop = new AbortController();
  const deps = createTestDeps({
    container: "worker",
    pool: testPool("worker_rw"),
    logger: createLogger("warn", (line) => log.push(line)),
  });
  const heartbeat = () => {
    beats.count += 1;
  };
  const runner = {
    stop,
    done: runJobs(deps, { signal: stop.signal, heartbeat }),
  };
  running.push(runner);
  return runner;
}

beforeEach(clearJobs);
afterEach(async () => {
  releaseBlocked();
  for (const runner of running) runner.stop.abort();
  await Promise.all(running.splice(0).map((runner) => runner.done));
});
afterAll(closeTestPools);

describe("runJobs", () => {
  it("never runs two of one kind at once: the second waits, then is skipped", async () => {
    startRunner();
    startRunner();
    const first = await enqueue(db, {
      job: "sync",
      runner: "worker",
      trigger: "schedule",
    });
    await until(first, "running");
    const second = await enqueue(db, {
      job: "sync",
      runner: "worker",
      trigger: "manual",
    });
    const skipped = await until(second, "skipped");
    expect(skipped.error).toBe(
      "another sync held the lock for all of 0.3 seconds",
    );
    const { taken_at, finished_at } = skipped;
    if (taken_at === null || finished_at === null)
      throw new Error("the skipped job has no times");
    expect(finished_at.getTime() - taken_at.getTime()).toBeGreaterThanOrEqual(
      300,
    );
    expect((await readJob(first)).status).toBe("running");
    releaseBlocked();
    await until(first, "succeeded");
  });

  it("returns a job to the queue when it stops while the job waits for the lock", async () => {
    startRunner();
    const first = await enqueue(db, {
      job: "refresh_idle_connections",
      runner: "worker",
      trigger: "schedule",
    });
    await until(first, "running");
    // The first runner is busy, so this one takes the second job, and waits.
    const stopping = startRunner();
    const second = await enqueue(db, {
      job: "refresh_idle_connections",
      runner: "worker",
      trigger: "manual",
    });
    await until(second, "running");
    stopping.stop.abort();
    await stopping.done;
    expect(await readJob(second)).toMatchObject({
      status: "queued",
      taken_at: null,
      error: null,
    });
  });

  it("rejects when Postgres ends the job's session, so the job never runs twice at once", async () => {
    const log: string[] = [];
    const lost = runJobs(
      createTestDeps({
        container: "worker",
        pool: testPool("worker_rw"),
        logger: createLogger("warn", (line) => log.push(line)),
      }),
      { signal: new AbortController().signal },
    ).then(
      () => null,
      (error: unknown) => {
        // What the entry does: it exits, and the job's handler ends with it.
        releaseBlocked();
        return error;
      },
    );
    const id = await enqueue(db, {
      job: "check",
      runner: "worker",
      trigger: "manual",
    });
    await until(id, "running");
    startRunner();
    // The second runner's first take has come back empty; its next is most
    // of a second away.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { rows } = await db.execute<{ ended: boolean }>(sql`
      select pg_terminate_backend(pid, 5000) as ended from pg_locks
      where locktype = 'advisory' and objsubid = 2
        and classid = hashtext(${TAKEN_LOCK})::oid and objid = hashtext(${id})::oid`);
    expect(rows).toEqual([{ ended: true }]);
    expect(await lost).toBeInstanceOf(Error);
    expect(log.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        time: expect.any(String) as unknown,
        level: "error",
        msg: "the job's session ended; the runner stops",
        job: "check",
        id,
      },
    ]);
    // The second runner finds the job abandoned and runs it, alone.
    for (let waited = 0; checks.runs < 2 && waited < 20_000; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checks).toMatchObject({ runs: 2, most: 1 });
  });

  it("records a failed handler's message, without its stack, and goes on", async () => {
    startRunner();
    const failing = await enqueue(db, {
      job: "embed",
      runner: "worker",
      trigger: "manual",
    });
    const next = await enqueue(db, {
      job: "expire_results",
      runner: "worker",
      trigger: "schedule",
      args: { older_than_hours: 24 },
    });
    await until(next, "succeeded");
    expect(await readJob(failing)).toMatchObject({
      status: "failed",
      error: "the embedding provider refused the key",
    });
    expect(expired).toEqual([
      { parameters: { older_than_hours: 24 }, trigger: "schedule" },
    ]);
  });

  it("fails a job without running it when the demo is off the sample", async () => {
    refuseDemo.mockRejectedValueOnce(new Error("demo off the sample"));
    const before = expired.length;
    startRunner();
    const id = await enqueue(db, {
      job: "expire_results",
      runner: "worker",
      trigger: "manual",
      args: { older_than_hours: 99 },
    });
    expect(await until(id, "failed")).toMatchObject({
      error: "demo off the sample",
    });
    expect(expired).toHaveLength(before);
  });

  it("leaves a job with no handler queued, says so once, and stays alive", async () => {
    const log: string[] = [];
    const beats = { count: 0 };
    startRunner(log, beats);
    const waiting = await enqueue(db, {
      job: "rekey_tokens",
      runner: "worker",
      trigger: "deploy",
    });
    // Two idle turns of a second each.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect((await readJob(waiting)).status).toBe("queued");
    const warnings = log
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.job === "rekey_tokens");
    expect(warnings).toEqual([
      expect.objectContaining({ level: "warn", container: "worker" }),
    ]);
    expect(beats.count).toBeGreaterThanOrEqual(2);
  });

  it("stops on the signal mid-wait while the queue is empty", async () => {
    const runner = startRunner();
    // Long enough for the first take to come back empty and the second-long
    // wait to begin, which the signal must cut short.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = performance.now();
    runner.stop.abort();
    await runner.done;
    expect(performance.now() - stopped).toBeLessThan(200);
  });
});

describe("handlerHere", () => {
  it("runs a job only in the container it is queued for, whatever handler this one has", () => {
    const check = { id: "a-job", job: "check" as const };
    expect(handlerHere("worker", { ...check, runner: "worker" })).toBeDefined();
    expect(() => handlerHere("worker", { ...check, runner: "api" })).toThrow(
      "took check (a-job), which is queued for the api, in the worker",
    );
  });
});
