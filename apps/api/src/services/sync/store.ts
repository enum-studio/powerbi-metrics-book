import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  and,
  DrizzleQueryError,
  eq,
  inArray,
  isNull,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Db } from "../../context.js";
import * as dax from "../../dax/index.js";
import {
  powerbiApp,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { chunks, ROWS_PER_STATEMENT } from "../../db/statements.js";
import { anyOf } from "../access/plan.js";
import type { ScanResult } from "../../powerbi/scanner.js";
import { dropAccess, replaceAccess } from "./access-lists.js";

/*
 * One scanned workspace into the mirror, in one transaction: the workspace,
 * its datasets and their schemas, and their access lists. Tables, columns and
 * measures have no Power BI ids, so they are keyed by dataset (or table) and
 * name; what a scan no longer shows gets removed_at and keeps its row, so a
 * curator's filing of a measure survives it going and coming back.
 */

export type ScannedWorkspace = ScanResult["workspaces"][number];
type ScannedDataset = NonNullable<ScannedWorkspace["datasets"]>[number];

export type StoreCounts = {
  added: number;
  changed: number;
  removed: number;
  renamed: number;
};
export type Stored = {
  /** Datasets whose schema changed or that went: the drafter's to look at. */
  changed_datasets: string[];
  counts: StoreCounts;
  /** Datasets left as they were, each with what to say of it and what stopped it. */
  failed_datasets: { id: string; reason: string; error: unknown }[];
};

const STALE_SCHEMA =
  "Power BI says this dataset's schema may not be up to date, so the last one read is kept.";
/**
 * What a scan's own values or size can make Postgres answer: a name twice
 * (21), a value it refuses (22, 23), a limit such as an index row's size (54),
 * and a statement past 65,535 parameters, which the wire cannot say (08P01).
 */
const CAUSED_BY_THE_DATA = /^(21|22|23|54|08P01)/;

type Row = Record<string, unknown> & { dataset_id: string };
type Old = Row & { id: string; removed_at: Date | null };
type OldMeasure = typeof powerbiMeasure.$inferSelect & { table_name: string };
type Measure = {
  dataset_id: string;
  table_name: string;
  name: string;
  expression: string | null;
};

/**
 * Postgres's own sentence, not drizzle's with the query and every parameter,
 * when a workspace or dataset's own data caused a failed query. It can quote
 * the one value it could not read as its type. Null for anything else: an
 * outage or a mistake of ours, which every dataset would meet, so the run ends.
 */
export function refusedByPostgres(error: unknown): string | null {
  if (!(error instanceof DrizzleQueryError)) return null;
  const { cause } = error;
  return cause instanceof pg.DatabaseError &&
    CAUSED_BY_THE_DATA.test(cause.code ?? "")
    ? `${cause.message}.`
    : null;
}

/**
 * What to say of a dataset that could not be stored: refusedByPostgres, or the
 * log's word for an error outside any query, in reading what the model holds.
 */
function failureOfDataset(error: unknown): string | null {
  return error instanceof DrizzleQueryError
    ? refusedByPostgres(error)
    : "The worker's log says why.";
}

/**
 * Writes the rows in statements of at most 1,000, handing `write` each part
 * and what a conflict over `key` sets: every other column the rows name, the
 * id apart, takes the inserted value. `insertOnly` values go into every
 * inserted row and stay out of the conflict's update.
 */
export async function upsert<R extends object, I extends object = object>(
  rows: readonly R[],
  key: readonly IndexColumn[],
  write: (part: (R & I)[], set: Record<string, SQL>) => Promise<unknown>,
  options: { insertOnly?: I } = {},
): Promise<void> {
  const kept = new Set(["id", ...key.map((column) => column.name)]);
  for (const part of chunks(rows, ROWS_PER_STATEMENT)) {
    const columns = Object.keys(part[0] ?? {}).filter((c) => !kept.has(c));
    const set = columns.map((c): [string, SQL] => [
      c,
      sql`excluded.${sql.identifier(c)}`,
    ]);
    const inserted = part.map((row) => ({ ...row, ...options.insertOnly }));
    await write(inserted as (R & I)[], Object.fromEntries(set));
  }
}

function schemaError(dataset: ScannedDataset): string | null {
  if (dataset.schemaRetrievalError !== undefined)
    return dataset.schemaRetrievalError;
  return dataset.schemaMayNotBeUpToDate === true ? STALE_SCHEMA : null;
}

function carriesRelationships(dataset: ScannedDataset): boolean {
  return (
    dataset.tables !== undefined &&
    schemaError(dataset) === null &&
    (dataset.relationships?.length ?? 0) > 0
  );
}

export async function storeWorkspace(
  db: Db,
  workspace: ScannedWorkspace,
  now: Date,
  newDatasetsEnabled: boolean,
): Promise<Stored> {
  return db.transaction(async (tx): Promise<Stored> => {
    const counts = { added: 0, changed: 0, removed: 0, renamed: 0 };
    // The scanner's schema has already spelled Power BI's enumerations the mirror's way.
    if (workspace.state === "deleted") {
      const gone = await removeWorkspaces(tx, [workspace.id], now);
      return { changed_datasets: gone, counts, failed_datasets: [] };
    }
    const fresh = { synced_at: now, removed_at: null };
    const { id, name, type, state, users } = workspace;
    const row = { id, name, type: type ?? null, state };
    const workspaceKey = [powerbiWorkspace.id];
    await upsert([{ ...row, ...fresh }], workspaceKey, (part, set) =>
      tx
        .insert(powerbiWorkspace)
        .values(part)
        .onConflictDoUpdate({ target: workspaceKey, set }),
    );
    await replaceAccess(tx, "workspace", new Map([[id, users]]), now);

    const datasets = workspace.datasets ?? [];
    const scanned = datasets.map((d) => d.id);
    const gone = await tx
      .select({ id: powerbiDataset.id })
      .from(powerbiDataset)
      .where(
        and(
          eq(powerbiDataset.workspace_id, id),
          isNull(powerbiDataset.removed_at),
          notInArray(powerbiDataset.id, scanned),
        ),
      );
    const changed_datasets = gone.map((d) => d.id);
    await removeDatasets(tx, changed_datasets, now);
    const failed_datasets: Stored["failed_datasets"] = [];
    for (const dataset of datasets) {
      const own = { added: 0, changed: 0, removed: 0, renamed: 0 };
      try {
        // A savepoint, so a dataset that cannot be stored costs itself alone.
        const changed = await tx.transaction((part) =>
          storeDataset(part, id, dataset, now, newDatasetsEnabled, own),
        );
        changed_datasets.push(...changed);
        counts.added += own.added;
        counts.changed += own.changed;
        counts.removed += own.removed;
        counts.renamed += own.renamed;
      } catch (error) {
        const reason = failureOfDataset(error);
        if (reason === null) throw error;
        failed_datasets.push({ id: dataset.id, reason, error });
      }
    }
    return { changed_datasets, counts, failed_datasets };
  });
}

/** One dataset, with its access list and its schema; answers it when its schema changed. */
async function storeDataset(
  tx: Db,
  workspaceId: string,
  dataset: ScannedDataset,
  now: Date,
  newDatasetsEnabled: boolean,
  counts: StoreCounts,
): Promise<Set<string>> {
  const carries = carriesRelationships(dataset);
  const row = {
    id: dataset.id,
    workspace_id: workspaceId,
    name: dataset.name,
    description_pbi: dataset.description ?? null,
    configured_by: dataset.configuredBy ?? null,
    target_storage_mode: dataset.targetStorageMode ?? null,
    schema_error: schemaError(dataset),
    relationships_source: carries ? ("scanner" as const) : null,
    relationships_read_at: carries ? now : null,
    synced_at: now,
    removed_at: null,
  };
  const datasetKey = [powerbiDataset.id];
  // Relationships read another way (info_view) stay theirs.
  const relationships_source = sql`coalesce(excluded.relationships_source, ${powerbiDataset.relationships_source})`;
  const relationships_read_at = sql`coalesce(excluded.relationships_read_at, ${powerbiDataset.relationships_read_at})`;
  await upsert(
    [row],
    datasetKey,
    (part, set) =>
      tx
        .insert(powerbiDataset)
        .values(part)
        .onConflictDoUpdate({
          target: datasetKey,
          set: { ...set, relationships_source, relationships_read_at },
        }),
    // An admin's switch is never the sync's to undo.
    { insertOnly: { enabled: newDatasetsEnabled } },
  );
  await replaceAccess(
    tx,
    "dataset",
    new Map([[dataset.id, dataset.users]]),
    now,
  );

  // A schema Power BI could not read, or did not send, is kept as it was.
  if (dataset.tables === undefined || schemaError(dataset) !== null)
    return new Set();
  const changed = await storeSchemas(tx, [dataset], now, counts);
  if (changed.size > 0)
    await tx
      .update(powerbiDataset)
      .set({ schema_changed_at: now })
      .where(eq(powerbiDataset.id, dataset.id));
  return changed;
}

/**
 * Compares the rows a scan gives with the rows stored under the same key,
 * counting what was added, changed or came back, and marking their dataset
 * changed. Answers the ids of live rows the scan no longer gives.
 */
function compare(
  old: readonly Old[],
  rows: readonly Row[],
  key: (row: Row) => string,
  changed: Set<string>,
  counts: StoreCounts,
): string[] {
  const before = new Map(old.map((row) => [key(row), row]));
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(key(row));
    const prior = before.get(key(row));
    const differs =
      prior === undefined ||
      prior.removed_at !== null ||
      Object.entries(row).some(([field, value]) => prior[field] !== value);
    if (!differs) continue;
    counts[prior === undefined ? "added" : "changed"] += 1;
    changed.add(row.dataset_id);
  }
  const removed = old.filter((r) => r.removed_at === null && !seen.has(key(r)));
  for (const row of removed) changed.add(row.dataset_id);
  counts.removed += removed.length;
  return removed.map((row) => row.id);
}

async function storeSchemas(
  tx: Db,
  datasets: readonly ScannedDataset[],
  now: Date,
  counts: StoreCounts,
): Promise<Set<string>> {
  const changed = new Set<string>();
  if (datasets.length === 0) return changed;
  const ids = datasets.map((d) => d.id);
  const fresh = { synced_at: now, removed_at: null };
  const byName = (row: Row) => `${row.dataset_id}/${String(row.name)}`;
  const inTable = (row: Row) => `${String(row.table_id)}/${String(row.name)}`;
  const tables = datasets.flatMap((d) =>
    (d.tables ?? []).map((table) => ({ dataset_id: d.id, table })),
  );

  const oldTables = await tx
    .select()
    .from(powerbiTable)
    .where(inArray(powerbiTable.dataset_id, ids));
  const tableIds = new Map(oldTables.map((t) => [byName(t), t.id]));
  const tableId = (dataset_id: string, name: string) => {
    const key = byName({ dataset_id, name });
    const id = tableIds.get(key) ?? randomUUID();
    tableIds.set(key, id);
    return id;
  };
  const tableRows = tables.map(({ dataset_id, table: t }) => ({
    id: tableId(dataset_id, t.name),
    dataset_id,
    name: t.name,
    is_hidden: t.isHidden ?? false,
    description_pbi: t.description ?? null,
  }));
  const goneTables = compare(oldTables, tableRows, byName, changed, counts);
  const tableKey = [powerbiTable.dataset_id, powerbiTable.name];
  const storedTables = tableRows.map((row) => ({ ...row, ...fresh }));
  await upsert(storedTables, tableKey, (part, set) =>
    tx
      .insert(powerbiTable)
      .values(part)
      .onConflictDoUpdate({ target: tableKey, set }),
  );

  const columnRows = tables.flatMap(({ dataset_id, table: t }) =>
    (t.columns ?? []).map((c) => ({
      dataset_id,
      table_id: tableId(dataset_id, t.name),
      name: c.name,
      data_type: c.dataType,
      column_type: c.columnType ?? null,
      expression: c.expression ?? null,
      is_hidden: c.isHidden ?? false,
      format_string: c.formatString ?? null,
      description_pbi: c.description ?? null,
    })),
  );
  const oldColumns = await tx
    .select()
    .from(powerbiColumn)
    .where(inArray(powerbiColumn.dataset_id, ids));
  const goneColumns = compare(oldColumns, columnRows, inTable, changed, counts);
  const columnKey = [powerbiColumn.table_id, powerbiColumn.name];
  const storedColumns = columnRows.map((row) => ({ ...row, ...fresh }));
  await upsert(storedColumns, columnKey, (part, set) =>
    tx
      .insert(powerbiColumn)
      .values(part)
      .onConflictDoUpdate({ target: columnKey, set }),
  );

  const scanned = tables.flatMap(({ dataset_id, table: t }) =>
    (t.measures ?? []).map((m) => ({
      dataset_id,
      table_id: tableId(dataset_id, t.name),
      name: m.name,
      expression: m.expression ?? null,
      format_string: m.formatString ?? null,
      is_hidden: m.isHidden ?? false,
      description_pbi: m.description ?? null,
    })),
  );
  const oldMeasures = await renameMeasures(
    tx,
    (
      await tx
        .select({ measure: powerbiMeasure, table_name: powerbiTable.name })
        .from(powerbiMeasure)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
        .where(inArray(powerbiMeasure.dataset_id, ids))
    ).map((row) => ({ ...row.measure, table_name: row.table_name })),
    tables.flatMap(({ dataset_id, table }) =>
      (table.measures ?? []).map((m) => ({
        dataset_id,
        table_name: table.name,
        name: m.name,
        expression: m.expression ?? null,
      })),
    ),
    changed,
    counts,
  );
  const prior = new Map(oldMeasures.map((m) => [byName(m), m]));
  const measureRows = scanned.map((row) => {
    const was = prior.get(byName(row));
    const expression_changed_at =
      was !== undefined && was.expression !== row.expression
        ? now
        : (was?.expression_changed_at ?? null);
    return { ...row, expression_changed_at };
  });
  const goneMeasures = compare(
    oldMeasures,
    measureRows,
    byName,
    changed,
    counts,
  );
  const measureKey = [powerbiMeasure.dataset_id, powerbiMeasure.name];
  const storedMeasures = measureRows.map((row) => ({ ...row, ...fresh }));
  await upsert(storedMeasures, measureKey, (part, set) =>
    tx
      .insert(powerbiMeasure)
      .values(part)
      .onConflictDoUpdate({ target: measureKey, set }),
  );

  const goneRelationships = await storeRelationships(
    tx,
    datasets.filter(carriesRelationships),
    now,
    changed,
    counts,
  );
  const removals = [
    [powerbiTable, goneTables],
    [powerbiColumn, goneColumns],
    [powerbiMeasure, goneMeasures],
    [powerbiRelationship, goneRelationships],
  ] as const;
  for (const [table, gone] of removals)
    if (gone.length > 0)
      await tx
        .update(table)
        .set({ removed_at: now })
        .where(anyOf(table.id, [...gone]));
  return changed;
}

/** Relationships have no name to key them by, so their two ends are the key. */
async function storeRelationships(
  tx: Db,
  datasets: readonly ScannedDataset[],
  now: Date,
  changed: Set<string>,
  counts: StoreCounts,
): Promise<string[]> {
  if (datasets.length === 0) return [];
  const old = await tx
    .select()
    .from(powerbiRelationship)
    .where(
      inArray(
        powerbiRelationship.dataset_id,
        datasets.map((d) => d.id),
      ),
    );
  const ends = (row: Row) =>
    [row.dataset_id, row.from_table, row.from_column, row.to_table]
      .concat(row.to_column)
      .map(String)
      .join("/");
  const ids = new Map(old.map((row) => [ends(row), row.id]));
  const rows = datasets.flatMap((d) =>
    (d.relationships ?? []).map((r) => {
      const row = {
        dataset_id: d.id,
        from_table: r.fromTable,
        from_column: r.fromColumn,
        to_table: r.toTable,
        to_column: r.toColumn,
        cross_filtering_behavior: r.crossFilteringBehavior ?? null,
      };
      return { ...row, id: ids.get(ends(row)) ?? randomUUID() };
    }),
  );
  // One row per pair of ends: the upsert may not touch a row twice.
  const unique = [...new Map(rows.map((row) => [ends(row), row])).values()];
  const gone = compare(old, unique, ends, changed, counts);
  const stored = unique.map((row) => ({
    ...row,
    synced_at: now,
    removed_at: null,
  }));
  const key = [powerbiRelationship.id];
  await upsert(stored, key, (part, set) =>
    tx
      .insert(powerbiRelationship)
      .values(part)
      .onConflictDoUpdate({ target: key, set }),
  );
  return gone;
}

/**
 * Renames, in the database and in the rows answered, each live measure the
 * scan no longer gives that one measure new to its dataset matches by
 * fingerprint, one to one. Two of either with one fingerprint pair nothing:
 * a wrong pairing would move a curator's filing to another calculation.
 */
async function renameMeasures(
  tx: Db,
  old: OldMeasure[],
  scanned: readonly Measure[],
  changed: Set<string>,
  counts: StoreCounts,
): Promise<OldMeasure[]> {
  const renamed = new Map<string, string>();
  for (const datasetId of new Set(scanned.map((m) => m.dataset_id))) {
    const before = old.filter((m) => m.dataset_id === datasetId);
    const after = scanned.filter((m) => m.dataset_id === datasetId);
    const known = new Set(before.map((m) => m.name));
    const kept = new Set(after.map((m) => m.name));
    const live = before.filter((m) => m.removed_at === null);
    const gone = await byFingerprint(live, (m) => !kept.has(m.name));
    if (gone.size === 0) continue;
    const added = await byFingerprint(after, (m) => !known.has(m.name));
    for (const [print, [from, ...others]] of gone) {
      const [to, ...rivals] = added.get(print) ?? [];
      if (from && to && others.length === 0 && rivals.length === 0)
        renamed.set(from.id, to.name);
    }
  }
  if (renamed.size === 0) return old;
  const pairs = [...renamed].map(([id, name]) => sql`(${id}::uuid, ${name})`);
  await tx.execute(
    sql`update ${powerbiMeasure} set name = renamed.name
        from (values ${sql.join(pairs, sql`, `)}) as renamed(id, name)
        where ${powerbiMeasure.id} = renamed.id`,
  );
  counts.renamed += renamed.size;
  return old.map((m) => {
    const name = renamed.get(m.id);
    if (name !== undefined) changed.add(m.dataset_id);
    return name === undefined ? m : { ...m, name };
  });
}

/** The measures `pick` chooses, by fingerprint against all of `measures`, one dataset's. */
async function byFingerprint<M extends Measure>(
  measures: readonly M[],
  pick: (measure: M) => boolean,
): Promise<Map<string, M[]>> {
  const map = dax.measureMap(
    measures.flatMap((m) =>
      m.expression === null
        ? []
        : [{ name: m.name, expression: m.expression, table: m.table_name }],
    ),
  );
  const groups = new Map<string, M[]>();
  for (const measure of measures.filter(pick)) {
    if (measure.expression === null) continue;
    try {
      const expanded = dax.expandMeasures(measure.name, map);
      if (!("expanded" in expanded)) continue;
      const print = dax.fingerprint(expanded.expanded);
      const group = groups.get(print);
      if (group === undefined) groups.set(print, [measure]);
      else group.push(measure);
    } catch (error) {
      if (!(error instanceof dax.DaxSyntaxError)) throw error;
    }
    // A tenant may publish many long measures: the worker's heartbeat runs between them.
    await nextTurn();
  }
  return groups;
}

/** Datasets that went, with everything in them; their access lists go too. */
export async function removeDatasets(
  tx: Db,
  ids: readonly string[],
  now: Date,
): Promise<void> {
  if (ids.length === 0) return;
  const list = [...ids];
  const { id, removed_at } = powerbiDataset;
  await tx
    .update(powerbiDataset)
    .set({ removed_at: now })
    .where(and(inArray(id, list), isNull(removed_at)));
  const parts = [
    powerbiTable,
    powerbiColumn,
    powerbiMeasure,
    powerbiRelationship,
  ];
  for (const part of parts)
    await tx
      .update(part)
      .set({ removed_at: now })
      .where(and(inArray(part.dataset_id, list), isNull(part.removed_at)));
  await dropAccess(tx, "dataset", list);
}

/** Workspaces that went, with their datasets and apps; answers the datasets. */
export async function removeWorkspaces(
  tx: Db,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const list = [...ids];
  await tx
    .update(powerbiWorkspace)
    .set({ removed_at: now })
    .where(
      and(
        inArray(powerbiWorkspace.id, list),
        isNull(powerbiWorkspace.removed_at),
      ),
    );
  const datasets = await tx
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(
      and(
        inArray(powerbiDataset.workspace_id, list),
        isNull(powerbiDataset.removed_at),
      ),
    );
  const datasetIds = datasets.map((row) => row.id);
  await removeDatasets(tx, datasetIds, now);
  const apps = await tx
    .update(powerbiApp)
    .set({ removed_at: now })
    .where(
      and(
        inArray(powerbiApp.workspace_id, list),
        isNull(powerbiApp.removed_at),
      ),
    )
    .returning({ id: powerbiApp.id });
  await dropAccess(
    tx,
    "app",
    apps.map((app) => app.id),
  );
  await dropAccess(tx, "workspace", list);
  return datasetIds;
}
