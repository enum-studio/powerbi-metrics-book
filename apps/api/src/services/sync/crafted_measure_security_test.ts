import { sampleTenant, type Tenant } from "@powerbi-metrics-book/powerbi-mock";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { closeTestPools, createTestDeps } from "../../../test/deps.js";
import { startPowerBi } from "../../../test/powerbi-support.js";
import { rolledBack, setRole } from "../../../test/sample-mirror.js";
import type { Db } from "../../context.js";
import { metricVariant } from "../../db/schema/book.js";
import { jobRequest } from "../../db/schema/jobs.js";
import {
  powerbiDataset,
  powerbiMeasure,
  syncRun,
} from "../../db/schema/mirror.js";
import { runSync } from "./run.js";

/*
 * Anyone who can publish a Power BI model writes the DAX the worker reads on
 * every sync. One such measure may cost that measure its place in the book. It
 * may not stop the sync, the datasets after it, or the worker's heartbeat.
 */

afterAll(closeTestPools);

const repeated = (text: string, times: number, by = " + ") =>
  Array.from({ length: times }, () => text).join(by);

const LITERAL = `"${"x".repeat(10_000)}"`;
const CRAFTED = {
  "a long literal read many times": `VAR a = ${LITERAL} RETURN ${repeated("a", 4_900)}`,
  "a longer literal read many times": `VAR a = "${"x".repeat(400_000)}" RETURN ${repeated("a", 600)}`,
  "more DAX than may be read": `"${"x".repeat(1_000_000)}"`,
};

type Scanned = Tenant["datasets"][number]["tables"][number]["measures"][number];

/** A copy of the first measure of the first dataset's first table, under a new name. */
function addTo(tenant: Tenant, name: string, expression: string): Scanned {
  const table = tenant.datasets[0]?.tables[0];
  const model = table?.measures[0];
  if (table === undefined || model === undefined)
    throw new Error("The sample has no measure");
  const added = { ...model, name, expression };
  table.measures.push(added);
  return added;
}

/** Runs full syncs of the tenant into one transaction that is always rolled back, as the worker. */
async function withSync(
  tenant: Tenant,
  work: (tx: Db, sync: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const { mock, deps: powerbi } = await startPowerBi(tenant);
  try {
    await rolledBack(TEST_RUNNER, async (tx) => {
      await setRole(tx, "worker_rw");
      const deps = createTestDeps({ ...powerbi, container: "worker", db: tx });
      await work(tx, () =>
        runSync(deps, { kind: "full", trigger: "manual", poll_ms: 1 }),
      );
    });
  } finally {
    await mock.close();
  }
}

const lastRun = async (tx: Db) =>
  (
    await tx.select().from(syncRun).orderBy(desc(syncRun.started_at)).limit(1)
  )[0];

const errorOf = async (tx: Db, name: string) =>
  (
    await tx
      .select({ error: powerbiMeasure.fingerprint_error })
      .from(powerbiMeasure)
      .where(eq(powerbiMeasure.name, name))
  )[0]?.error;

describe("a sync that meets a crafted measure", () => {
  it.each(Object.entries(CRAFTED))(
    "stores every dataset, records the error and goes on, with %s",
    async (_, expression) => {
      const tenant = sampleTenant();
      addTo(tenant, "Crafted", expression);
      await withSync(tenant, async (tx, sync) => {
        await sync();
        expect(await lastRun(tx)).toMatchObject({ status: "succeeded" });
        expect(await errorOf(tx, "Crafted")).toContain("characters");
        const stored = await tx.select().from(powerbiDataset);
        expect(stored).toHaveLength(tenant.datasets.length);
        const queued = await tx.select().from(jobRequest);
        expect(queued.map((job) => job.job)).toContain("embed");
      });
    },
  );

  it.each(Object.entries(CRAFTED))(
    "goes on when a measure of the dataset was renamed too, with %s",
    async (_, expression) => {
      const tenant = sampleTenant();
      const renamed = addTo(
        tenant,
        "Plain before",
        "COUNTROWS('Sales lines') * 7",
      );
      await withSync(tenant, async (tx, sync) => {
        await sync();
        renamed.name = "Plain after";
        addTo(tenant, "Crafted", expression);
        await sync();
        expect(await lastRun(tx)).toMatchObject({ status: "succeeded" });
        expect(await errorOf(tx, "Crafted")).toContain("characters");
        expect(await errorOf(tx, "Plain after")).toBeNull();
      });
    },
  );

  it("does not read a measure too long that only an unread variable reaches, and says it may read the selection", async () => {
    const tenant = sampleTenant();
    addTo(tenant, "Huge", repeated("1", 300_000));
    addTo(tenant, "Reads it", "VAR unused = [Huge] RETURN 1");
    await withSync(tenant, async (tx, sync) => {
      await sync();
      expect(await lastRun(tx)).toMatchObject({ status: "succeeded" });
      expect(await errorOf(tx, "Huge")).toContain("characters");
      expect(await errorOf(tx, "Reads it")).toBeNull();
      const [filed] = await tx
        .select({ reads: metricVariant.reads_selection })
        .from(metricVariant)
        .innerJoin(
          powerbiMeasure,
          eq(powerbiMeasure.id, metricVariant.measure_id),
        )
        .where(eq(powerbiMeasure.name, "Reads it"));
      expect(filed?.reads).toBe(true);
    });
  });

  it("keeps the worker's event loop turning through many long measures", async () => {
    const tenant = sampleTenant();
    for (let k = 0; k < 40; k += 1)
      addTo(tenant, `Long ${String(k)}`, repeated("1", 49_000));
    await withSync(tenant, async (tx, sync) => {
      let last = performance.now();
      let longest = 0;
      const heartbeat = setInterval(() => {
        longest = Math.max(longest, performance.now() - last);
        last = performance.now();
      }, 10);
      try {
        await sync();
      } finally {
        clearInterval(heartbeat);
      }
      expect(await lastRun(tx)).toMatchObject({ status: "succeeded" });
      expect(longest).toBeLessThan(2_000);
    });
  });

  it("keeps the worker's event loop turning while a composed shift looks for its base among many measures", async () => {
    const tenant = sampleTenant();
    // Sorts first, so no measure has been read when it asks.
    addTo(tenant, "0 Asks", "[Net sales LY] + 1");
    const variables = Array.from(
      { length: 99 },
      (_, v) => `VAR v${String(v)}=1`,
    ).join(" ");
    const reads = Array.from({ length: 99 }, (_, v) => `v${String(v)}`).join(
      "+",
    );
    const body = `${variables} VAR z=${repeated("1", 230, "+")} RETURN ${reads}+${repeated("z", 40, "+")}`;
    // Enough that reading them all in one turn passes the limit on an idle machine.
    for (let k = 0; k < 100; k += 1)
      addTo(tenant, `Slow ${String(k)}`, `${body}+${String(k)}`);
    await withSync(tenant, async (tx, sync) => {
      let last = performance.now();
      let longest = 0;
      const heartbeat = setInterval(() => {
        longest = Math.max(longest, performance.now() - last);
        last = performance.now();
      }, 10);
      try {
        await sync();
      } finally {
        clearInterval(heartbeat);
      }
      expect(await lastRun(tx)).toMatchObject({ status: "succeeded" });
      expect(longest).toBeLessThan(2_000);
    });
  }, 300_000);

  it("leaves a dataset turned off unread until it changes", async () => {
    const tenant = sampleTenant();
    const crafted = addTo(tenant, "Crafted", "COUNTROWS('Sales lines') * 7");
    await withSync(tenant, async (tx, sync) => {
      await sync();
      const off = tenant.datasets[0]?.id;
      if (off === undefined) throw new Error("The sample has no dataset");
      await tx
        .update(powerbiDataset)
        .set({ enabled: false })
        .where(eq(powerbiDataset.id, off));
      const named = and(
        eq(powerbiMeasure.dataset_id, off),
        eq(powerbiMeasure.name, "Crafted"),
      );
      await tx.update(powerbiMeasure).set({ fingerprint: null }).where(named);
      await sync();
      const read = () =>
        tx
          .select({ fingerprint: powerbiMeasure.fingerprint })
          .from(powerbiMeasure)
          .where(named);
      expect((await read())[0]?.fingerprint).toBeNull();

      crafted.expression = "COUNTROWS('Sales lines') * 8";
      await sync();
      expect((await read())[0]?.fingerprint).not.toBeNull();
    });
  });
});
