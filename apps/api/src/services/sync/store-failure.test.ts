import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { find, startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import { powerbiDataset, syncRun } from "../../db/schema/mirror.js";
import type * as AccessLists from "./access-lists.js";
import { runSync } from "./run.js";

const SECRET_WORDS = "a sentence that quotes the model";
const tenant = sampleTenant();
const sales = find(tenant.datasets, (d) => d.name === "Sales");
const retail = find(tenant.datasets, (d) => d.name === "Retail");

vi.mock("./access-lists.js", async (original) => {
  const actual = await original<typeof AccessLists>();
  return {
    ...actual,
    replaceAccess: async (...args: Parameters<typeof actual.replaceAccess>) => {
      const [, kind, lists] = args;
      if (kind === "dataset" && lists.has(sales.id))
        throw new RangeError(SECRET_WORDS);
      await actual.replaceAccess(...args);
    },
  };
});

afterAll(closeTestPools);

describe("runSync when reading a dataset fails outside any query", () => {
  it("fails that dataset alone, says the log has why, and logs it", async () => {
    const { mock, deps: powerbi } = await startPowerBi(tenant);
    try {
      await rolledBack(TEST_RUNNER, async (tx) => {
        await setRole(tx, "worker_rw");
        const deps = createTestDeps({
          ...powerbi,
          container: "worker",
          db: tx,
        });
        const errors = vi.spyOn(deps.logger, "error");
        await expect(
          runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 }),
        ).rejects.toThrow(sales.id);

        const stored = (id: string) =>
          tx.select().from(powerbiDataset).where(eq(powerbiDataset.id, id));
        expect(await stored(sales.id)).toEqual([]);
        expect(await stored(retail.id)).toHaveLength(1);
        const [run] = await tx
          .select()
          .from(syncRun)
          .orderBy(desc(syncRun.started_at))
          .limit(1);
        expect(run?.counts).toMatchObject({ datasets_failed: 1 });
        expect(run?.error).toContain("The worker's log says why.");
        expect(run?.error).not.toContain(SECRET_WORDS);
        expect(errors).toHaveBeenCalledWith(
          "A dataset could not be stored.",
          expect.objectContaining({ dataset_id: sales.id }),
        );
      });
    } finally {
      await mock.close();
    }
  });
});
