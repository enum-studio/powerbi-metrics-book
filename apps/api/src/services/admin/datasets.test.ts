import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  asPerson,
  id,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import { principals } from "../../../test/deps.js";
import { auditEvent } from "../../db/schema/audit.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import type { Db } from "../../context.js";
import { enqueue } from "../jobs/queue.js";
import { listDatasets, setEnabled } from "./datasets.js";
import { startSync } from "./sync.js";

useMirror();

// No Power BI access at all: the list is the admin section's, not the catalog's.
const admin = (db?: Db) =>
  asPerson(reaching({}, "admin"), db === undefined ? {} : { db });
const curator = () => asPerson(principals.curator);

const queuedEmbeds = async (tx: Db) =>
  (
    await tx
      .select({ id: jobRequest.id })
      .from(jobRequest)
      .where(and(eq(jobRequest.job, "embed"), eq(jobRequest.status, "queued")))
  ).length;

const queuedDrafts = async (tx: Db, dataset: string) =>
  (
    await tx
      .select({ id: jobRequest.id })
      .from(jobRequest)
      .where(
        and(
          eq(jobRequest.job, "sync"),
          eq(jobRequest.status, "queued"),
          sql`${jobRequest.args}->>'draft_dataset' = ${dataset}`,
        ),
      )
  ).length;

const enabledOf = async (tx: Db, dataset: string) =>
  (
    await tx
      .select({ enabled: powerbiDataset.enabled })
      .from(powerbiDataset)
      .where(eq(powerbiDataset.id, dataset))
  )[0]?.enabled;

describe("setEnabled", () => {
  it("turns a dataset off and queues one embed run", async () => {
    await rolledBack(async (tx) => {
      const before = await queuedEmbeds(tx);
      const answer = await setEnabled(admin(tx), id.sales, false);
      expect(answer).toEqual({
        id: id.sales,
        name: "Sales",
        enabled: false,
      });
      expect(await enabledOf(tx, id.sales)).toBe(false);
      // A run already waiting stands for this one.
      expect(await queuedEmbeds(tx)).toBe(Math.max(before, 1));
    });
  });

  it("asks the worker to draft a dataset when it goes from off to on, and only then", async () => {
    await rolledBack(async (tx) => {
      await enqueue(tx, {
        job: "sync",
        runner: "worker",
        args: { kind: "incremental" },
        trigger: "schedule",
      });
      await setEnabled(admin(tx), id.sales, true);
      expect(await queuedDrafts(tx, id.sales)).toBe(0);
      await setEnabled(admin(tx), id.sales, false);
      expect(await queuedDrafts(tx, id.sales)).toBe(0);
      // A sync already queued may skip its drafting, so it does not stand for this.
      await setEnabled(admin(tx), id.sales, true);
      expect(await queuedDrafts(tx, id.sales)).toBe(1);
    });
  });

  it("does not let a request to draft one dataset stand for a sync an admin asks for", async () => {
    await rolledBack(async (tx) => {
      await setEnabled(admin(tx), id.sales, false);
      await setEnabled(admin(tx), id.sales, true);
      const { job_id } = await startSync(admin(tx), "incremental");
      const [asked] = await tx
        .select({ args: jobRequest.args })
        .from(jobRequest)
        .where(eq(jobRequest.id, job_id));
      expect(asked?.args).toEqual({ kind: "incremental" });
      // And the sync that stands is the one answered, not the older request.
      const again = await startSync(admin(tx), "full");
      expect(again).toEqual({ job_id, queued: false });
    });
  });

  it("audits the change with the dataset's id and name", async () => {
    await rolledBack(async (tx) => {
      await setEnabled(admin(tx), "Finance", false);
      await setEnabled(admin(tx), "Finance", true);
    });
    const events = await admin()
      .db.select()
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, id.finance));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["admin.dataset.off", "admin.dataset.on"]),
    );
    expect(events[0]?.detail).toEqual({
      id: id.finance,
      name: "Finance",
    });
  });

  it("asks for the id when several datasets share the name", async () => {
    await expect(setEnabled(admin(), "Twin", false)).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("Use the id") as unknown,
    });
  });

  it("is not_found for a name no live dataset has, and for a removed one", async () => {
    await expect(
      setEnabled(admin(), "No such dataset", false),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(setEnabled(admin(), id.old, false)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("refuses a curator", async () => {
    await expect(setEnabled(curator(), id.sales, false)).rejects.toMatchObject({
      kind: "refused",
    });
  });

  it("hides the dataset from describableDatasets, and on again shows it", async () => {
    await rolledBack(async (tx) => {
      const person = reaching({ powerbi_workspace_ids: [id.sales_workspace] });
      const seen = async () => {
        const context = asPerson(person, { db: tx });
        const allowed = await context.access.describableDatasets(person);
        return (
          await tx
            .select({ id: powerbiDataset.id })
            .from(powerbiDataset)
            .where(and(allowed, eq(powerbiDataset.id, id.sales)))
        ).length;
      };
      expect(await seen()).toBe(1);
      await setEnabled(admin(tx), id.sales, false);
      expect(await seen()).toBe(0);
      await setEnabled(admin(tx), id.sales, true);
      expect(await seen()).toBe(1);
    });
  });
});

describe("listDatasets", () => {
  it("lists every live dataset, off ones and ones the admin cannot reach included", async () => {
    await rolledBack(async (tx) => {
      await setEnabled(admin(tx), id.finance, false);
      const listed = await listDatasets(admin(tx));
      const sales = listed.find((d) => d.id === id.sales);
      expect(sales).toMatchObject({
        name: "Sales",
        workspace_id: id.sales_workspace,
        workspace_name: "Sales",
        enabled: true,
        tables: 2,
        columns: 2,
        measures: 3,
        synced_at: expect.any(String) as unknown,
      });
      expect(listed.find((d) => d.id === id.finance)).toMatchObject({
        enabled: false,
        tables: 1,
        columns: 1,
        measures: 1,
      });
      expect(listed.map((d) => d.id)).toEqual(
        expect.arrayContaining([id.twin_a, id.twin_b]),
      );
      expect(listed.map((d) => d.id)).not.toContain(id.old);
    });
  });

  it("refuses a curator", async () => {
    await expect(listDatasets(curator())).rejects.toMatchObject({
      kind: "refused",
    });
  });
});
