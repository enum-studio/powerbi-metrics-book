import { randomUUID } from "node:crypto";
import { and, inArray, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { SettingValues } from "../../context.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import type { Principal } from "../../principal.js";
import { inRollback } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";

afterAll(closeTestPools);

/*
 * Lists and search show only the datasets describableDatasets lets through,
 * so this is the line between a person and metadata Power BI does not show
 * them. Each case runs the real policies in Cerbos and the condition in
 * Postgres.
 */

const ids = {
  member_workspace: randomUUID(),
  app_workspace: randomUUID(),
  other_workspace: randomUUID(),
  sales_app: randomUUID(),
  member_dataset: randomUUID(),
  app_dataset_a: randomUUID(),
  app_dataset_b: randomUUID(),
  unshown_dataset: randomUUID(),
  other_dataset: randomUUID(),
  off_member_dataset: randomUUID(),
};
const everyDataset = [
  ids.member_dataset,
  ids.app_dataset_a,
  ids.app_dataset_b,
  ids.unshown_dataset,
  ids.other_dataset,
];

/** The ids of the seeded datasets the condition lets through, read in a transaction that is rolled back. */
function visible(
  condition: SQL,
  datasetIds: string[] = everyDataset,
): Promise<string[]> {
  return inRollback(testPool("worker_rw"), async (client) => {
    // One statement: a foreign key is checked when it ends, so the order does not matter.
    await client.query(
      `with w as (insert into powerbi_workspace (id, name) values
                    ($1, 'Sample data members'), ($2, 'Sample data apps'), ($3, 'Sample data other')),
            a as (insert into powerbi_app (id, name, workspace_id) values ($4, 'Sample data Sales', $2)),
            d as (insert into powerbi_dataset (id, workspace_id, name, endorsement) values
                    ($5, $1, 'Sample data members', null), ($6, $2, 'Sample data sales a', null),
                    ($7, $2, 'Sample data sales b', null), ($8, $2, 'Sample data unshown', null),
                    ($9, $3, 'Sample data other', 'Certified'))
       insert into powerbi_app_dataset (app_id, dataset_id) values ($4, $6), ($4, $7)`,
      [
        ids.member_workspace,
        ids.app_workspace,
        ids.other_workspace,
        ids.sales_app,
        ...everyDataset,
      ],
    );
    await client.query(
      "insert into powerbi_dataset (id, workspace_id, name, enabled) values ($1, $2, 'Sample data members off', false)",
      [ids.off_member_dataset, ids.member_workspace],
    );
    const rows = await drizzle({ client })
      .select({ id: powerbiDataset.id })
      .from(powerbiDataset)
      .where(and(condition, inArray(powerbiDataset.id, datasetIds)));
    return rows.map((row) => row.id).sort();
  });
}

function reaching(lists: Principal["attributes"]): Principal {
  return {
    ...principals.viewer,
    attributes: { ...principals.viewer.attributes, ...lists },
  };
}

async function describable(
  principal: Principal,
  mode: SettingValues["access.metadata_visibility"],
  policies: "defaults" | "override" = "defaults",
): Promise<string[]> {
  const access = cerbosAccess(
    new MemorySettings({ "access.metadata_visibility": mode }),
    policies,
  );
  return visible(await access.describableDatasets(principal));
}

describe("describableDatasets", () => {
  it("gives a person in one app's audience exactly the datasets behind that app", async () => {
    const appOnly = reaching({ powerbi_app_ids: [ids.sales_app] });
    expect(await describable(appOnly, "powerbi")).toEqual(
      [ids.app_dataset_a, ids.app_dataset_b].sort(),
    );
  });

  it("gives a person Power BI lists nothing to no dataset under powerbi", async () => {
    expect(await describable(principals.viewer, "powerbi")).toEqual([]);
  });

  it("gives the same person every dataset under everyone", async () => {
    expect(await describable(principals.viewer, "everyone")).toEqual(
      [...everyDataset].sort(),
    );
  });

  it("gives no dataset under policy, however much Power BI lists, until the deployment's policy says", async () => {
    const reachesAll = reaching({
      powerbi_workspace_ids: [ids.member_workspace, ids.other_workspace],
      powerbi_app_ids: [ids.sales_app],
      powerbi_dataset_ids: [ids.unshown_dataset],
    });
    expect(await describable(reachesAll, "policy")).toEqual([]);
  });

  it("joins a workspace, an app and a direct share, and nothing beside them", async () => {
    const mixed = reaching({
      powerbi_workspace_ids: [ids.member_workspace],
      powerbi_app_ids: [ids.sales_app],
      powerbi_dataset_ids: [ids.unshown_dataset],
    });
    const access = cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "powerbi" }),
    );
    expect(
      await visible(await access.describableDatasets(mixed), [
        ...everyDataset,
        ids.off_member_dataset,
      ]),
    ).toEqual(
      [
        ids.member_dataset,
        ids.app_dataset_a,
        ids.app_dataset_b,
        ids.unshown_dataset,
      ].sort(),
    );
  });
});

describe("reachableDatasets", () => {
  it("includes an off dataset the principal reaches and excludes one it does not", async () => {
    const access = cerbosAccess(
      new MemorySettings({ "access.metadata_visibility": "powerbi" }),
    );
    const memberOnly = reaching({
      powerbi_workspace_ids: [ids.member_workspace],
      powerbi_app_ids: [],
      powerbi_dataset_ids: [],
    });
    expect(
      await visible(await access.reachableDatasets(memberOnly), [
        ids.off_member_dataset,
        ids.other_dataset,
      ]),
    ).toEqual([ids.off_member_dataset]);
  });
});

describe("describableDatasets for a service account", () => {
  const modes = ["powerbi", "everyone", "policy"] as const;

  function serviceAccount(lists: Principal["attributes"]): Principal {
    return {
      ...reaching(lists),
      kind: "service_account",
      id: "test-service-account",
      via: "api",
    };
  }

  // A direct share in its lists is no part of what its admin gave it.
  const granted = serviceAccount({
    powerbi_workspace_ids: [ids.other_workspace],
    powerbi_app_ids: [ids.sales_app],
    powerbi_dataset_ids: [ids.unshown_dataset],
  });

  it.each(modes)(
    "gives one exactly its workspaces and apps under %s",
    async (mode) => {
      expect(await describable(granted, mode)).toEqual(
        [ids.other_dataset, ids.app_dataset_a, ids.app_dataset_b].sort(),
      );
    },
  );

  it.each(modes)(
    "gives one granted nothing no dataset under %s",
    async (mode) => {
      expect(await describable(serviceAccount({}), mode)).toEqual([]);
    },
  );

  // The example deployment opens certified datasets (other_dataset here) to
  // everyone signed in; the api still holds a service account to its grant.
  describe("under a deployment policy that widens", () => {
    it("shows a person with no lists the certified dataset, so the widening is live", async () => {
      expect(
        await describable(principals.viewer, "powerbi", "override"),
      ).toEqual([ids.other_dataset]);
    });

    it.each(modes)(
      "keeps a service account to its grant under %s",
      async (mode) => {
        const appOnly = serviceAccount({ powerbi_app_ids: [ids.sales_app] });
        expect(await describable(appOnly, mode, "override")).toEqual(
          [ids.app_dataset_a, ids.app_dataset_b].sort(),
        );
        expect(await describable(serviceAccount({}), mode, "override")).toEqual(
          [],
        );
      },
    );
  });
});
