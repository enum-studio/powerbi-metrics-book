import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../context.js";
import {
  type ACCESS_OBJECT_KINDS,
  powerbiAccess,
} from "../../db/schema/mirror.js";
import { chunks, ROWS_PER_STATEMENT } from "../../db/statements.js";
import type { AccessEntry } from "../../powerbi/admin.js";
import type { ScannedWorkspace } from "./store.js";

/*
 * Who Power BI says may reach a workspace, an app or a dataset. Each
 * object's list is replaced whole, in the transaction that stores the
 * object, so visibility never mixes two scans of one object.
 */

type ObjectKind = (typeof ACCESS_OBJECT_KINDS)[number];

/**
 * Makes each object's rows its list: rows still listed keep their id, stale
 * ones are deleted, new ones added. An object whose list is undefined keeps
 * its rows: a list Power BI did not send is not an empty one.
 */
export async function replaceAccess(
  tx: Db,
  kind: ObjectKind,
  lists: ReadonlyMap<string, readonly AccessEntry[] | undefined>,
  now: Date,
): Promise<void> {
  const sent = [...lists].flatMap(([id, list]) => (list ? [{ id, list }] : []));
  if (sent.length === 0) return;
  const key = (row: Omit<AccessEntry, "email" | "access_right">) =>
    `${row.principal_type}/${row.principal_object_id}`;
  // One row per principal and object: the upsert may not touch a row twice.
  const rows = new Map(
    sent.flatMap(({ id: object_id, list }) =>
      list.map((entry) => [
        `${object_id}/${key(entry)}`,
        { ...entry, object_kind: kind, object_id, synced_at: now },
      ]),
    ),
  );
  const existing = await tx
    .select()
    .from(powerbiAccess)
    .where(
      and(
        eq(powerbiAccess.object_kind, kind),
        inArray(
          powerbiAccess.object_id,
          sent.map((object) => object.id),
        ),
      ),
    );
  const stale = existing.filter((r) => !rows.has(`${r.object_id}/${key(r)}`));
  for (const part of chunks(stale, ROWS_PER_STATEMENT))
    await tx.delete(powerbiAccess).where(
      inArray(
        powerbiAccess.id,
        part.map((row) => row.id),
      ),
    );
  const { object_kind, object_id, principal_type, principal_object_id } =
    powerbiAccess;
  for (const part of chunks([...rows.values()], ROWS_PER_STATEMENT))
    await tx
      .insert(powerbiAccess)
      .values(part)
      .onConflictDoUpdate({
        target: [object_kind, object_id, principal_type, principal_object_id],
        set: {
          email: sql`excluded.email`,
          access_right: sql`excluded.access_right`,
          synced_at: sql`excluded.synced_at`,
        },
      });
}

/**
 * How many of a scanned workspace's access lists Power BI did not send: its
 * own, and each dataset's. Their stored rows stay as they were, so each sync
 * run counts these for an admin to see.
 */
export function unsentLists(workspace: ScannedWorkspace): number {
  if (workspace.state === "deleted") return 0;
  const datasets = workspace.datasets ?? [];
  return (
    (workspace.users === undefined ? 1 : 0) +
    datasets.filter((dataset) => dataset.users === undefined).length
  );
}

/** An object that is gone gives no one visibility. */
export async function dropAccess(
  tx: Db,
  kind: ObjectKind,
  objectIds: readonly string[],
): Promise<void> {
  if (objectIds.length === 0) return;
  const { object_kind, object_id } = powerbiAccess;
  await tx
    .delete(powerbiAccess)
    .where(and(eq(object_kind, kind), inArray(object_id, [...objectIds])));
}

/** Entries stored with no right reach no one, so each sync run counts them. */
export function accessWithoutRight(db: Db): Promise<number> {
  return db.$count(powerbiAccess, isNull(powerbiAccess.access_right));
}
