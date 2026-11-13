import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { desc } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { syncRun } from "../../db/schema/mirror.js";
import type * as Drafter from "../book/drafter.js";
import { runSync } from "./run.js";

const FIRST_FAILED = "d1000000-0000-4000-8000-000000000001";
const SECOND_FAILED = "d1000000-0000-4000-8000-000000000002";

vi.mock("../book/drafter.js", async (original) => {
  const actual = await original<typeof Drafter>();
  return {
    ...actual,
    draftDatasets: async (
      ...args: Parameters<typeof actual.draftDatasets>
    ) => ({
      ...(await actual.draftDatasets(...args)),
      failed: 2,
      failed_datasets: [FIRST_FAILED, SECOND_FAILED],
    }),
  };
});

afterAll(closeTestPools);

describe("runSync when datasets could not be drafted", () => {
  it("fails, says so, and still does what follows the drafter", async () => {
    const { mock, deps: powerbi } = await startPowerBi(sampleTenant());
    try {
      await rolledBack(TEST_RUNNER, async (tx) => {
        await setRole(tx, "worker_rw");
        const deps = createTestDeps({
          ...powerbi,
          container: "worker",
          db: tx,
        });
        await expect(
          runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 }),
        ).rejects.toThrow(
          `Dataset ${FIRST_FAILED} could not be drafted, so its drafts were left as they were. The worker's log says why. Dataset ${SECOND_FAILED} could not be drafted`,
        );
        const [run] = await tx
          .select()
          .from(syncRun)
          .orderBy(desc(syncRun.started_at))
          .limit(1);
        expect(run).toMatchObject({ status: "failed" });
        expect(run?.counts).toMatchObject({ drafts_failed: 2 });
        const queued = await tx.select().from(jobRequest);
        expect(queued.map((job) => job.job)).toContain("embed");
      });
    } finally {
      await mock.close();
    }
  });
});
