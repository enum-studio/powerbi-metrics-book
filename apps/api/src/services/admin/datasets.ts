import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { enqueue, enqueueUnlessQueued } from "../jobs/queue.js";
import { byIdOrName } from "../mirror/read.js";
import { audited, requireAdmin } from "./guard.js";

/*
 * The admin's list of datasets and their on or off switch. The list covers
 * every live dataset whatever the admin's own Power BI access, so it does not
 * go through describableDatasets: an admin who turns datasets on or off has to
 * see them, and the list holds names and counts, not data.
 */

export type DatasetRow = {
  id: string;
  name: string;
  workspace_id: string;
  workspace_name: string;
  enabled: boolean;
  tables: number;
  columns: number;
  measures: number;
  synced_at: string | null;
};

const liveCount = (
  child: typeof powerbiTable | typeof powerbiColumn | typeof powerbiMeasure,
) =>
  sql<number>`(select count(*)::int from ${child} where ${child.dataset_id} = ${powerbiDataset.id} and ${child.removed_at} is null)`;

export async function listDatasets(
  context: ServiceContext,
): Promise<DatasetRow[]> {
  await requireAdmin(context, "manage_datasets");
  const rows = await context.db
    .select({
      id: powerbiDataset.id,
      name: powerbiDataset.name,
      workspace_id: powerbiDataset.workspace_id,
      workspace_name: powerbiWorkspace.name,
      enabled: powerbiDataset.enabled,
      tables: liveCount(powerbiTable),
      columns: liveCount(powerbiColumn),
      measures: liveCount(powerbiMeasure),
      synced_at: powerbiDataset.synced_at,
    })
    .from(powerbiDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(isNull(powerbiDataset.removed_at))
    .orderBy(
      asc(powerbiWorkspace.name),
      asc(powerbiDataset.name),
      asc(powerbiDataset.id),
    );
  return rows.map((row) => ({
    ...row,
    synced_at: row.synced_at.toISOString(),
  }));
}

/**
 * Turns a live dataset, by id or exact name, on or off, audited. A full embed
 * run is queued in the same transaction, so the dataset's documents leave or
 * return. Turning one on also asks the worker to draft it: a dataset that is off
 * is not drafted unless it changes, so a draft of it can hold a name its readers
 * may not see, from an older book or a PII rule set since it went off. A sync
 * would not do: one soon after another returns before it drafts.
 */
export async function setEnabled(
  context: ServiceContext,
  dataset: string,
  enabled: boolean,
): Promise<{ id: string; name: string; enabled: boolean }> {
  await requireAdmin(context, "manage_datasets");
  const found = await context.db.transaction(async (tx) => {
    const [first, other] = await tx
      .select({
        id: powerbiDataset.id,
        name: powerbiDataset.name,
        was_on: powerbiDataset.enabled,
      })
      .from(powerbiDataset)
      .where(
        and(
          byIdOrName(powerbiDataset, dataset),
          isNull(powerbiDataset.removed_at),
        ),
      )
      .limit(2);
    if (first === undefined)
      throw new ServiceError("not_found", "No such dataset.");
    if (other !== undefined)
      throw new ServiceError(
        "invalid",
        `Several datasets are named "${dataset}". Use the id of the one to turn ${enabled ? "on" : "off"}.`,
      );
    await tx
      .update(powerbiDataset)
      .set({ enabled })
      .where(eq(powerbiDataset.id, first.id));
    await enqueueUnlessQueued(tx, {
      job: "embed",
      runner: "worker",
      args: {},
      trigger: "schedule",
    });
    // One each time: a request standing from an earlier on could already have
    // read the dataset as off, and it costs no scan.
    if (enabled && !first.was_on)
      await enqueue(tx, {
        job: "sync",
        runner: "worker",
        args: { draft_dataset: first.id },
        trigger: "schedule",
        requested_by: context.principal.id,
      });
    return { id: first.id, name: first.name };
  });
  await audited(
    context,
    enabled ? "dataset.on" : "dataset.off",
    { kind: "dataset", id: found.id },
    { id: found.id, name: found.name },
  );
  return { ...found, enabled };
}
