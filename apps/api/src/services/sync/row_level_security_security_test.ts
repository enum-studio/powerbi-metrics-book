import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { runSync } from "./run.js";

afterAll(closeTestPools);

/*
 * The api refuses a service account's query on a model with row-level
 * security before it fetches any token (query_identity_security_test). That
 * refusal reads has_row_level_security, so the sync must store it from the
 * scan: the security tests load their mirror from the mock tenant directly,
 * and would not see a sync that dropped it.
 */

const flags = (tenant: Tenant) =>
  Object.fromEntries(
    tenant.datasets.map((d) => [d.name, d.has_row_level_security]),
  );

it("stores each dataset's row-level security from the scan, and its change on the next sync", async () => {
  const tenant = sampleTenant();
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const deps = createTestDeps({ ...powerbi, container: "worker", db: tx });
      const sync = () =>
        runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 });
      const stored = async () =>
        Object.fromEntries(
          (
            await tx
              .select({
                name: powerbiDataset.name,
                on: powerbiDataset.has_row_level_security,
              })
              .from(powerbiDataset)
              .where(
                inArray(
                  powerbiDataset.id,
                  tenant.datasets.map((d) => d.id),
                ),
              )
          ).map(({ name, on }) => [name, on]),
        );

      expect(await sync()).toMatchObject({ status: "succeeded" });
      expect(flags(tenant)).toMatchObject({
        Finance: true,
        Retail: true,
        Sales: false,
      });
      expect(await stored()).toEqual(flags(tenant));

      for (const dataset of tenant.datasets)
        dataset.has_row_level_security = dataset.name === "Sales";
      expect(await sync()).toMatchObject({ status: "succeeded" });
      expect(await stored()).toEqual(flags(tenant));
      expect((await stored()).Sales).toBe(true);
      expect((await stored()).Finance).toBe(false);
    });
  } finally {
    await mock.close();
  }
}, 120_000);
