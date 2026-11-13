import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testPool,
} from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { errorSentence } from "../../http/error-log.js";
import { createLogger } from "../../log.js";
import { enqueue } from "./queue.js";
import { registerJob } from "./registry.js";
import { runJobs } from "./runner.js";

/*
 * What a job leaves behind is read by whoever reads the worker's log and the
 * job's row. A failed query's message holds its parameters, which can be a
 * model's DAX, an email or a token's ciphertext. Text that Postgres cannot
 * keep must not stop the worker that was only recording a failure.
 */

const db = createDb(testPool("worker_rw"));
const PARAMETER = "a value only the query was given";

registerJob("embed", "worker", async () => {
  await db.execute(sql`select 1 / ${0}::int, ${PARAMETER}::text`);
});
registerJob("check", "worker", () =>
  Promise.reject(new Error("Power BI said \u0000 and \ud83d and went on")),
);
registerJob("expire_results", "worker", () =>
  Promise.reject(new Error("x".repeat(100_000))),
);
registerJob("sync", "worker", () => Promise.resolve());

const running: { stop: AbortController; done: Promise<void> }[] = [];
function startRunner(log: string[]) {
  const stop = new AbortController();
  const deps = createTestDeps({
    container: "worker",
    pool: testPool("worker_rw"),
    logger: createLogger("info", (line) => log.push(line)),
  });
  running.push({ stop, done: runJobs(deps, { signal: stop.signal }) });
}

async function until(id: string, status: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [job] = await db
      .select()
      .from(jobRequest)
      .where(eq(jobRequest.id, id));
    if (job?.status === status) return job;
    if (Date.now() > deadline)
      throw new Error(`job ${id} is ${String(job?.status)}, not ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const queue = (job: "embed" | "check" | "expire_results" | "sync") =>
  enqueue(db, { job, runner: "worker", trigger: "manual" });

beforeEach(async () => {
  await createDb(testPool("migrator")).delete(jobRequest);
});
afterEach(async () => {
  for (const runner of running) runner.stop.abort();
  await Promise.all(running.splice(0).map((runner) => runner.done));
});
afterAll(closeTestPools);

describe("what a failed job leaves behind", () => {
  it("keeps a failed query as Postgres's own message, on its row and in the log, not drizzle's with its parameters", async () => {
    const log: string[] = [];
    startRunner(log);
    const id = await queue("embed");
    const job = await until(id, "failed");
    expect(job.error).toBe("division by zero");
    const finished = log.filter((line) => line.includes("job finished"));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toContain("division by zero");
    expect(log.join("\n")).not.toContain(PARAMETER);
  });

  it("keeps in that message the one value Postgres could not read as its type, and no other parameter", async () => {
    const other = "another value only the query was given";
    const failure: unknown = await db
      .execute(sql`select ${PARAMETER}::uuid, ${other}::text`)
      .catch((error: unknown) => error);
    expect(errorSentence(failure)).toBe(
      `invalid input syntax for type uuid: "${PARAMETER}"`,
    );
  });

  it("records a failure whose text Postgres could not keep, and goes on", async () => {
    startRunner([]);
    const id = await queue("check");
    const job = await until(id, "failed");
    expect(job.error).toMatch(/^Power BI said .* and went on$/);
    expect(job.error).not.toContain("\u0000");
    expect(job.error?.isWellFormed()).toBe(true);
    await until(await queue("sync"), "succeeded");
  });

  it("cuts a failure's text", async () => {
    startRunner([]);
    const job = await until(await queue("expire_results"), "failed");
    expect(job.error?.length).toBeLessThanOrEqual(16_000);
  });
});
