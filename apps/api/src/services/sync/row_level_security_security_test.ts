import { randomUUID } from "node:crypto";
import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { runSync } from "./run.js";
import { storeWorkspace } from "./store.js";

afterAll(closeTestPools);

/*
 * The api refuses a service account's query on a model Power BI answers only
 * for a person, before it fetches any token (query_identity_security_test).
 * That refusal reads has_row_level_security and requires_effective_identity,
 * so the sync must store both from the scan: the security tests load their
 * mirror from the mock tenant directly, and would not see a sync that
 * dropped them.
 */

const select = {
  name: powerbiDataset.name,
  roles: powerbiDataset.has_row_level_security,
  person: powerbiDataset.requires_effective_identity,
};

/** What the mirror should hold for each sample dataset. */
const expected = (tenant: Tenant) =>
  Object.fromEntries(
    tenant.datasets.map((d) => [
      d.name,
      {
        roles: d.has_row_level_security,
        person: d.has_row_level_security || d.effective_identity_required,
      },
    ]),
  );

async function stored(tx: Db, tenant: Tenant) {
  const rows = await tx
    .select(select)
    .from(powerbiDataset)
    .where(
      inArray(
        powerbiDataset.id,
        tenant.datasets.map((d) => d.id),
      ),
    );
  return Object.fromEntries(rows.map(({ name, ...flags }) => [name, flags]));
}

it("stores each dataset's row-level security and need for a person from the scan, and their change on the next sync", async () => {
  const tenant = sampleTenant();
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const deps = createTestDeps({ ...powerbi, container: "worker", db: tx });
      const sync = () =>
        runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 });

      expect(await sync()).toMatchObject({ status: "succeeded" });
      // Roles of its own, single sign-on with no roles, and neither.
      expect(expected(tenant)).toMatchObject({
        Finance: { roles: true, person: true },
        Retail: { roles: true, person: true },
        "Campaign archive": { roles: false, person: true },
        Sales: { roles: false, person: false },
      });
      expect(await stored(tx, tenant)).toEqual(expected(tenant));

      for (const dataset of tenant.datasets) {
        dataset.has_row_level_security = dataset.name === "Sales";
        dataset.effective_identity_required = false;
      }
      expect(await sync()).toMatchObject({ status: "succeeded" });
      expect(await stored(tx, tenant)).toEqual(expected(tenant));
      expect((await stored(tx, tenant)).Sales).toEqual({
        roles: true,
        person: true,
      });
      expect((await stored(tx, tenant)).Finance).toEqual({
        roles: false,
        person: false,
      });
    });
  } finally {
    await mock.close();
  }
}, 120_000);

it("keeps both flags as stored when a scan leaves them out or sends null", async () => {
  await rolledBack(TEST_RUNNER, async (tx) => {
    await setRole(tx, "worker_rw");
    const workspace = { id: randomUUID(), name: "Model", state: "active" };
    const dataset = { id: randomUUID(), name: "Model" };
    const scan = (flags: Record<string, boolean | null>) => ({
      ...workspace,
      datasets: [{ ...dataset, ...flags }],
    });
    const flags = async () =>
      (
        await tx
          .select(select)
          .from(powerbiDataset)
          .where(eq(powerbiDataset.id, dataset.id))
      ).map(({ roles, person }) => ({ roles, person }));

    await storeWorkspace(
      tx,
      scan({
        isEffectiveIdentityRolesRequired: true,
        isEffectiveIdentityRequired: true,
      }),
      new Date(),
      true,
    );
    expect(await flags()).toEqual([{ roles: true, person: true }]);

    await storeWorkspace(tx, scan({}), new Date(), true);
    expect(await flags()).toEqual([{ roles: true, person: true }]);

    await storeWorkspace(
      tx,
      scan({
        isEffectiveIdentityRolesRequired: null,
        isEffectiveIdentityRequired: null,
      }),
      new Date(),
      true,
    );
    expect(await flags()).toEqual([{ roles: true, person: true }]);

    // Single sign-on alone: no roles, but only a person is answered.
    await storeWorkspace(
      tx,
      scan({
        isEffectiveIdentityRolesRequired: false,
        isEffectiveIdentityRequired: true,
      }),
      new Date(),
      true,
    );
    expect(await flags()).toEqual([{ roles: false, person: true }]);

    // Roles answered, the need for a person left out: that need stays.
    await storeWorkspace(
      tx,
      scan({ isEffectiveIdentityRolesRequired: false }),
      new Date(),
      true,
    );
    expect(await flags()).toEqual([{ roles: false, person: true }]);

    // Roles alone are enough to need a person.
    await storeWorkspace(
      tx,
      scan({ isEffectiveIdentityRolesRequired: true }),
      new Date(),
      true,
    );
    expect(await flags()).toEqual([{ roles: true, person: true }]);
  });
});
