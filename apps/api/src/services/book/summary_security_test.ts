import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { asPerson, outsider, reaching } from "../../../test/mirror-fixtures.js";
import {
  inSampleMirror,
  type SampleMirror,
  setRole,
} from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import type { Principal } from "../../principal.js";
import { listDatasets } from "../mirror/read.js";
import { draftDatasets } from "./drafter.js";
import { listMetrics, summarizeBook } from "./metrics.js";

afterAll(closeTestPools);

const drafted = (work: (tx: Db, sample: SampleMirror) => Promise<void>) =>
  inSampleMirror("worker_rw", async (tx, sample) => {
    await draftDatasets(
      createTestDeps({ container: "worker", db: tx }),
      sample.tenant.datasets.map((dataset) => dataset.id),
    );
    await setRole(tx, "api_rw");
    await work(tx, sample);
  });

/** What the caller's lists hold, which is what the summary may count and nothing more. */
async function listed(tx: Db, principal: Principal) {
  const context = asPerson(principal, { db: tx });
  const metrics = await listMetrics(context, { limit: 500 });
  const datasets = await listDatasets(context, { limit: 500 });
  const notFiled = await listMetrics(context, { limit: 500, not_filed: true });
  expect(metrics.next_cursor).toBeNull();
  expect(datasets.next_cursor).toBeNull();
  expect(notFiled.next_cursor).toBeNull();
  return {
    metrics: metrics.items.length,
    datasets: datasets.items.length,
    not_filed: notFiled.items.length,
  };
}

async function counted(tx: Db, principal: Principal) {
  const { datasets, metrics, not_filed } = await summarizeBook(
    asPerson(principal, { db: tx }),
  );
  return {
    datasets,
    metrics: metrics.draft + metrics.agent_verified + metrics.human_verified,
    not_filed,
  };
}

const workspaceOf = (sample: SampleMirror, name: string) => {
  const found = sample.tenant.workspaces.find((each) => each.name === name);
  if (found === undefined) throw new Error(`The sample has no ${name}`);
  return found.id;
};

describe("the book's summary", () => {
  it("answers counts and nothing else, so no label can reach a pasted prompt", () =>
    drafted(async (tx, sample) => {
      const summary = await summarizeBook(
        asPerson(
          reaching(
            {
              powerbi_workspace_ids: sample.tenant.workspaces.map(
                ({ id }) => id,
              ),
            },
            "curator",
          ),
          { db: tx },
        ),
      );
      expect(summary).toEqual({
        datasets: expect.any(Number) as unknown,
        metrics: {
          draft: expect.any(Number) as unknown,
          agent_verified: expect.any(Number) as unknown,
          human_verified: expect.any(Number) as unknown,
        },
        not_filed: expect.any(Number) as unknown,
      });
    }));

  it("counts nothing for someone who reaches no dataset, and nothing but metrics with no dataset at all", () =>
    drafted(async (tx) => {
      expect(await counted(tx, outsider)).toEqual(await listed(tx, outsider));
      expect((await counted(tx, outsider)).datasets).toBe(0);
    }));

  it("counts for a service account with no grant what its lists show", () =>
    drafted(async (tx) => {
      const account: Principal = {
        ...reaching({}),
        kind: "service_account",
      };
      expect(await counted(tx, account)).toEqual(await listed(tx, account));
      expect((await counted(tx, account)).datasets).toBe(0);
    }));

  it("counts for a curator of one workspace that workspace, and fewer than a curator of all", () =>
    drafted(async (tx, sample) => {
      const one = reaching(
        { powerbi_workspace_ids: [workspaceOf(sample, "Marketing")] },
        "curator",
      );
      const all = reaching(
        {
          powerbi_workspace_ids: sample.tenant.workspaces.map(({ id }) => id),
        },
        "curator",
      );
      const narrow = await counted(tx, one);
      expect(narrow).toEqual(await listed(tx, one));
      expect(narrow.datasets).toBeGreaterThan(0);
      const wide = await counted(tx, all);
      expect(wide).toEqual(await listed(tx, all));
      expect(narrow.datasets).toBeLessThan(wide.datasets);
      expect(narrow.metrics).toBeLessThan(wide.metrics);
    }));

  it("stops counting a dataset an admin switched off, and a removed one", () =>
    drafted(async (tx, sample) => {
      const all = reaching(
        {
          powerbi_workspace_ids: sample.tenant.workspaces.map(({ id }) => id),
        },
        "curator",
      );
      const before = await counted(tx, all);
      const [off, removed] = sample.tenant.datasets;
      if (off === undefined || removed === undefined)
        throw new Error("The sample has two datasets");
      await setRole(tx, "worker_rw");
      await tx
        .update(powerbiDataset)
        .set({ enabled: false })
        .where(eq(powerbiDataset.id, off.id));
      await tx
        .update(powerbiDataset)
        .set({ removed_at: new Date() })
        .where(eq(powerbiDataset.id, removed.id));
      await setRole(tx, "api_rw");
      const after = await counted(tx, all);
      expect(after).toEqual(await listed(tx, all));
      expect(after.datasets).toBeLessThan(before.datasets);
    }));
});
