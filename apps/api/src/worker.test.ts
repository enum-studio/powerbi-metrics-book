import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testEnvironment,
  testPool,
} from "../test/deps.js";
import { jobRequest } from "./db/schema/jobs.js";
import { createLogger } from "./log.js";
import { enqueue } from "./services/jobs/queue.js";
import { registerJob } from "./services/jobs/registry.js";
import { runWorker, startWorker } from "./worker.js";

// The job modules a later issue lists there are not under test here: the
// worker runs only the job this file registers.
vi.mock("./services/jobs/all.js", () => ({}));
vi.mock("./deps.js", () => ({
  buildDeps: () =>
    Promise.resolve({
      ...createTestDeps({ container: "worker", pool: testPool("worker_rw") }),
      close: () => Promise.resolve(),
    }),
}));
const refuse = vi.hoisted(() => vi.fn());
vi.mock("./services/setup/tenant.js", () => ({ refuseAnotherTenant: refuse }));

const refuseDemo = vi.hoisted(() => vi.fn());
vi.mock("./services/demo/locks.js", () => ({
  refuseDemoOffTheSample: refuseDemo,
}));

let heartbeat_dir: string;

beforeAll(async () => {
  heartbeat_dir = await mkdtemp(join(tmpdir(), "pbmb-worker-"));
});

afterAll(async () => {
  await rm(heartbeat_dir, { recursive: true, force: true });
  await closeTestPools();
});

const handled: Record<string, unknown>[] = [];
registerJob("expire_results", "worker", (_deps, parameters) => {
  handled.push(parameters);
  return Promise.resolve();
});

describe("runWorker", () => {
  it("queues a deploy sync, runs the job a test registered, beats, and stops on the signal", async () => {
    const lines: string[] = [];
    const deps = createTestDeps({
      container: "worker",
      pool: testPool("worker_rw"),
      logger: createLogger("warn", (line) => lines.push(line)),
    });
    const heartbeat_file = join(heartbeat_dir, "worker-heartbeat");
    const stop = new AbortController();
    const running = runWorker(deps, { signal: stop.signal, heartbeat_file });

    const id = await enqueue(deps.db, {
      job: "expire_results",
      runner: "worker",
      args: { older_than: "now" },
      trigger: "manual",
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [job] = await deps.db
        .select()
        .from(jobRequest)
        .where(eq(jobRequest.id, id));
      // The worker notices the queued sync on a turn of its own loop, which
      // may come after the job the test queued is done.
      const noticed = lines.some((line) => line.includes("queued jobs wait"));
      if (job?.status === "succeeded" && noticed) break;
      if (Date.now() > deadline)
        throw new Error(
          `job ${id} is ${job?.status ?? "missing"}; the queued sync was ${noticed ? "" : "not "}noticed`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stop.abort();
    await running;

    expect(handled).toEqual([{ older_than: "now" }]);
    const syncs = await deps.db
      .select()
      .from(jobRequest)
      .where(eq(jobRequest.job, "sync"));
    // No sync handler is registered here, so the job waits for a worker that
    // has one, and the worker says so once.
    expect(
      syncs.map(({ trigger, status, args: parameters }) => ({
        trigger,
        status,
        parameters,
      })),
    ).toEqual([
      {
        trigger: "deploy",
        status: "queued",
        parameters: { kind: "incremental" },
      },
    ]);
    expect(
      lines.filter((line) => line.includes("queued jobs wait")),
    ).toHaveLength(1);
    expect(Date.now() - (await stat(heartbeat_file)).mtimeMs).toBeLessThan(
      30_000,
    );
  });
});

describe("startWorker", () => {
  it("refuses to start against another tenant, before it takes a job", async () => {
    refuse.mockRejectedValueOnce(new Error("another tenant"));
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      startWorker(testEnvironment("worker"), stopped.signal),
    ).rejects.toThrow("another tenant");
  });

  it("refuses to start a demo that is off the sample, before it takes a job", async () => {
    refuseDemo.mockRejectedValueOnce(new Error("demo off the sample"));
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      startWorker(testEnvironment("worker"), stopped.signal),
    ).rejects.toThrow("demo off the sample");
  });
});
