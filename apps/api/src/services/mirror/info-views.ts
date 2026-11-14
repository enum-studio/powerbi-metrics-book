import { connectionsPage } from "../../config.js";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, ServiceContext } from "../../context.js";
import {
  modelViewRead,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiRelationship,
  powerbiTable,
} from "../../db/schema/mirror.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import { parseAnswer } from "../../powerbi/errors.js";
import { mirrorSpelling } from "../../powerbi/scanner.js";
import { connectionState } from "../connection/store.js";
import { readModelView } from "../queries/execute.js";
import { createResultStore } from "../queries/store.js";
import { countRequest } from "../rate-limit.js";

/*
 * The scanner gives neither relationships nor display folders, so they are
 * read from Power BI's INFO views with the asking person's own token,
 * through the query service. Power BI refusing the INFO functions for the
 * dataset (a 400) is remembered; any other refusal is one person's rights
 * and writes nothing, so someone else may still read them.
 */

/** A person's failed read is not tried again for them sooner than this. */
const RETRY_SECONDS = 5 * 60;

/**
 * How long a request waits for the same person's read of the dataset that is
 * already running, on this replica or another, before it answers without it.
 * A read takes about a second.
 */
const WAIT_MS = 30_000;
const POLL_MS = 200;

export type ModelDetails = Pick<
  typeof powerbiDataset.$inferSelect,
  "relationships_source" | "relationships_read_at"
> & {
  relationships_current: boolean;
  /** Says so, in a fixed sentence, when the caller cannot be given the relationships; null when what is listed is what there is. */
  relationships_note: string | null;
};

type Unknown =
  "unavailable" | "no_connection" | "no_build" | "no_access" | "later";

function unknownBecause(context: ServiceContext, why: Unknown): string {
  const page = connectionsPage(context.config);
  const sentences: Record<Unknown, string> = {
    unavailable:
      "Power BI refuses the INFO functions on this dataset, so its relationships cannot be read. Ask its owner in Power BI. They are read again after the model next changes.",
    no_connection: `They are read with a person's own Power BI connection. Connect Power BI at ${page} and ask again; a service account has none, so it asks a person who has connected.`,
    no_build:
      "Power BI refused the query for your connection, most often because you lack the Build right on this dataset; ask its owner in Power BI.",
    no_access:
      "Power BI does not show this dataset to your connection, or your access here does not let you query it; ask its owner in Power BI or an admin.",
    later: "They were tried a moment ago and are tried again in a few minutes.",
  };
  const when = why === "later" ? " for now" : "";
  return `Relationships are unknown${when}. ${sentences[why]}`;
}

/** Why the read failed, for the caller's sentence; the text of the failure is never passed on. */
function whyUnknown(error: ServiceError): Unknown {
  const { status } = error.detail;
  if (status === 400) return "unavailable";
  if (status === 403) return "no_build";
  if (status === 404 || error.kind === "not_found" || error.kind === "refused")
    return "no_access";
  return error.kind === "needs_connection" ? "no_connection" : "later";
}

/** The note with a warning when stored relationships are listed beside it: they predate the model's last change. */
export const withListed = (note: string | null, listed: number) =>
  note !== null && listed > 0
    ? `${note} The relationships listed were read before the model last changed and may be out of date.`
    : note;

const relationshipRows = z.array(
  z
    .object({
      "[FromTable]": z.string(),
      "[FromColumn]": z.string(),
      "[FromCardinality]": z.string(),
      "[ToTable]": z.string(),
      "[ToColumn]": z.string(),
      "[ToCardinality]": z.string(),
      "[CrossFilteringBehavior]": z.string().nullable(),
      "[IsActive]": z.boolean(),
    })
    .transform((row) => ({
      from_table: row["[FromTable]"],
      from_column: row["[FromColumn]"],
      to_table: row["[ToTable]"],
      to_column: row["[ToColumn]"],
      cardinality: `${mirrorSpelling(row["[FromCardinality]"])}_to_${mirrorSpelling(row["[ToCardinality]"])}`,
      cross_filtering_behavior: row["[CrossFilteringBehavior]"]?.length
        ? mirrorSpelling(row["[CrossFilteringBehavior]"])
        : null,
      is_active: row["[IsActive]"],
    })),
);
/** Power BI answers a measure or column with no display folder as null or as an empty string; the mirror stores none. */
const noneIfBlank = (folder: string | null) => (folder === "" ? null : folder);
const measureRows = z.array(
  z
    .object({ "[Name]": z.string(), "[DisplayFolder]": z.string().nullable() })
    .transform((row) => ({
      name: row["[Name]"],
      folder: noneIfBlank(row["[DisplayFolder]"]),
    })),
);
const columnRows = z.array(
  z
    .object({
      "[Table]": z.string(),
      "[Name]": z.string(),
      "[DisplayFolder]": z.string().nullable(),
    })
    .transform((row) => ({
      table: row["[Table]"],
      name: row["[Name]"],
      folder: noneIfBlank(row["[DisplayFolder]"]),
    })),
);
type Views = {
  relationships: z.output<typeof relationshipRows>;
  measures: z.output<typeof measureRows>;
  columns: z.output<typeof columnRows>;
};

/** What the dataset records: settled when there is nothing to read, and the answer to give while it stays unread. */
async function recorded(
  context: ServiceContext,
  datasetId: string,
): Promise<{
  settled: ModelDetails | null;
  answer: (why: Unknown | null) => ModelDetails;
}> {
  const [row] = await context.db
    .select({
      relationships_source: powerbiDataset.relationships_source,
      relationships_read_at: powerbiDataset.relationships_read_at,
      schema_changed_at: powerbiDataset.schema_changed_at,
      schema_error: powerbiDataset.schema_error,
      synced_at: powerbiDataset.synced_at,
      removed_at: powerbiDataset.removed_at,
    })
    .from(powerbiDataset)
    .where(eq(powerbiDataset.id, datasetId));
  if (row === undefined) throw new ServiceError("not_found", NO_SUCH_DATASET);
  const {
    schema_changed_at: changedAt,
    schema_error: schemaError,
    synced_at: syncedAt,
    removed_at: removedAt,
    ...read
  } = row;
  const { relationships_source: source, relationships_read_at: readAt } = read;
  const stale =
    readAt === null ||
    (changedAt !== null && readAt < changedAt) ||
    (schemaError !== null && readAt < syncedAt);
  const due = source === null || stale;
  const answer = (why: Unknown | null): ModelDetails => ({
    ...read,
    relationships_current:
      source !== null && source !== "unavailable" && readAt !== null && !stale,
    relationships_note: why && unknownBecause(context, why),
  });
  const settled =
    removedAt !== null
      ? answer(null)
      : due
        ? null
        : answer(source === "unavailable" ? "unavailable" : null);
  return { settled, answer };
}

/**
 * Reads the relationships and display folders when due and the caller is a
 * connected person, and answers what the dataset records, with a note when
 * the caller was not given the relationships. Due: never read, or the schema
 * changed since (a refusal of the INFO functions counts as a read). A removed
 * dataset is not read. Relationships from a scan also expire with the schema.
 * A request that overlaps the same person's read waits for it.
 */
export async function ensureModelDetails(
  context: ServiceContext,
  datasetId: string,
): Promise<ModelDetails> {
  // Before the first query, so a schema change during the read is read again.
  const startedAt = context.clock();
  const { db, principal } = context;
  const { settled, answer } = await recorded(context, datasetId);
  if (settled !== null) return settled;
  if (
    principal.kind !== "person" ||
    (await connectionState(db, principal.id)) !== "connected"
  )
    return answer("no_connection");
  const claimed = await claimRead(db, principal.id, datasetId, startedAt);
  if (claimed !== null)
    try {
      return await readViews(context, datasetId, startedAt, answer);
    } finally {
      await endRead(context, datasetId, claimed);
    }
  // Looked at again whatever the wait saw: the read may have ended before the first look at its row.
  await waitForRead(context, datasetId);
  const after = await recorded(context, datasetId);
  return after.settled ?? after.answer("later");
}

/**
 * Counts the read against the person's five minutes and, when it may run,
 * records it as running, in one transaction: a request the count refuses
 * finds the running read's row, unless the read has already ended. Answers
 * the row's started_at, Postgres's clock, or null when the count refuses.
 */
function claimRead(
  db: Db,
  userId: string,
  datasetId: string,
  at: Date,
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const verdict = await countRequest(
      tx,
      `relationships:${userId}:${datasetId}`,
      { window_seconds: RETRY_SECONDS, max: 1 },
      at,
    );
    if (!verdict.allowed) return null;
    const [row] = await tx
      .insert(modelViewRead)
      .values({ user_id: userId, dataset_id: datasetId })
      .onConflictDoUpdate({
        target: [modelViewRead.user_id, modelViewRead.dataset_id],
        set: { started_at: sql`now()` },
      })
      .returning({ started_at: modelViewRead.started_at });
    if (row === undefined) throw new Error("upsert returned no row");
    return row.started_at;
  });
}

const runningRead = (userId: string, datasetId: string) =>
  and(
    eq(modelViewRead.user_id, userId),
    eq(modelViewRead.dataset_id, datasetId),
  );

/**
 * Deletes the read's row, only its own (a later read may have replaced it).
 * A failure is logged, not thrown, so it never replaces the read's answer or
 * error; the row left behind is not waited on once it is WAIT_MS old.
 */
async function endRead(
  context: ServiceContext,
  datasetId: string,
  startedAt: Date,
): Promise<void> {
  try {
    await context.db
      .delete(modelViewRead)
      .where(
        and(
          runningRead(context.principal.id, datasetId),
          eq(modelViewRead.started_at, startedAt),
        ),
      );
  } catch (error) {
    context.logger.warn("the record of a finished relationships read stayed", {
      dataset_id: datasetId,
      user_id: context.principal.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Waits while the person's read runs, for at most WAIT_MS, and stops when
 * the caller goes away. A row that started longer ago than that, by
 * Postgres's clock, is not waited on: its reader died, or is so slow that
 * waiting would not help.
 */
async function waitForRead(
  context: ServiceContext,
  datasetId: string,
): Promise<void> {
  const { db, principal, signal } = context;
  const deadline = performance.now() + WAIT_MS;
  const recent = sql`${modelViewRead.started_at} > now() - make_interval(secs => ${WAIT_MS / 1000})`;
  while (performance.now() < deadline && signal?.aborted !== true) {
    const [row] = await db
      .select({ started_at: modelViewRead.started_at })
      .from(modelViewRead)
      .where(and(runningRead(principal.id, datasetId), recent));
    if (row === undefined) return;
    await sleep(POLL_MS, undefined, { signal }).catch((error: unknown) => {
      if (signal?.aborted !== true) throw error;
    });
  }
}

/** Reads the INFO views with the person's token and stores what Power BI says. */
async function readViews(
  context: ServiceContext,
  datasetId: string,
  startedAt: Date,
  answer: (why: Unknown | null) => ModelDetails,
): Promise<ModelDetails> {
  const { principal } = context;
  const view = async <S extends z.ZodType>(
    name: "RELATIONSHIPS" | "MEASURES" | "COLUMNS",
    schema: S,
  ): Promise<z.output<S>> => {
    const anchor = await readModelView(context, datasetId, name);
    const results = createResultStore(context);
    try {
      const rows: Record<string, unknown>[] = [];
      const stream = results.stream(principal, anchor.result_id);
      for await (const values of stream)
        rows.push(
          Object.fromEntries(anchor.columns.map((c, i) => [c.name, values[i]])),
        );
      return parseAnswer(schema, rows, `Power BI's ${name.toLowerCase()} view`);
    } finally {
      await results.delete(principal, anchor.result_id);
    }
  };
  let views: Views;
  try {
    const relationships = await view("RELATIONSHIPS", relationshipRows);
    const measures = await view("MEASURES", measureRows);
    views = {
      relationships,
      measures,
      columns: await view("COLUMNS", columnRows),
    };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    const why = whyUnknown(error);
    if (why === "unavailable")
      return store(context, datasetId, startedAt, null);
    if (why === "later")
      context.logger.warn("reading the dataset's INFO views failed", {
        dataset_id: datasetId,
        error: error.message,
      });
    return answer(why);
  }
  return store(context, datasetId, startedAt, views);
}

/** What Power BI read; its refusal (null) leaves the stored relationships and folders as they are. */
async function store(
  context: ServiceContext,
  datasetId: string,
  at: Date,
  views: Views | null,
): Promise<ModelDetails> {
  const details = {
    relationships_source: views === null ? "unavailable" : "info_view",
    relationships_read_at: at,
  } as const;
  const current = await context.db.transaction(async (tx) => {
    // The update comes first: it holds the dataset's row, so two readers never both add its relationships.
    const [stored] = await tx
      .update(powerbiDataset)
      .set(details)
      .where(eq(powerbiDataset.id, datasetId))
      .returning({
        changed_at: powerbiDataset.schema_changed_at,
        schema_error: powerbiDataset.schema_error,
        synced_at: powerbiDataset.synced_at,
      });
    if (views === null) return false;
    await replaceRelationships(tx, datasetId, views.relationships, at);
    await setDisplayFolders(tx, datasetId, views.measures);
    await setColumnFolders(tx, datasetId, views.columns);
    return (
      stored !== undefined &&
      (stored.changed_at === null || at >= stored.changed_at) &&
      (stored.schema_error === null || at >= stored.synced_at)
    );
  });
  const why = views === null ? "unavailable" : null;
  return {
    ...details,
    relationships_current: current,
    relationships_note: why && unknownBecause(context, why),
  };
}

const endsOf = (
  r: Record<"from_table" | "from_column" | "to_table" | "to_column", string>,
) => JSON.stringify([r.from_table, r.from_column, r.to_table, r.to_column]);

/**
 * Relationships have no name, so their two ends are the key. A row stays
 * the same row (and keeps what a curator wrote on it) while Power BI still
 * gives its ends; one it no longer gives is marked removed.
 */
async function replaceRelationships(
  tx: Db,
  datasetId: string,
  read: Views["relationships"],
  now: Date,
): Promise<void> {
  const stored = await tx
    .select()
    .from(powerbiRelationship)
    .where(eq(powerbiRelationship.dataset_id, datasetId));
  const ids = new Map(stored.map((row) => [endsOf(row), row.id]));
  if (read.length > 0)
    await tx
      .insert(powerbiRelationship)
      .values(
        read.map((row) => ({
          ...row,
          id: ids.get(endsOf(row)),
          dataset_id: datasetId,
          synced_at: now,
          removed_at: null,
        })),
      )
      .onConflictDoUpdate({
        target: powerbiRelationship.id,
        set: {
          cardinality: sql`excluded.cardinality`,
          cross_filtering_behavior: sql`excluded.cross_filtering_behavior`,
          is_active: sql`excluded.is_active`,
          synced_at: sql`excluded.synced_at`,
          removed_at: sql`excluded.removed_at`,
        },
      });
  const kept = new Set(read.map(endsOf));
  const gone = stored.filter(
    (row) => row.removed_at === null && !kept.has(endsOf(row)),
  );
  if (gone.length > 0)
    await tx
      .update(powerbiRelationship)
      .set({ removed_at: now })
      .where(
        inArray(
          powerbiRelationship.id,
          gone.map((row) => row.id),
        ),
      );
}

async function setDisplayFolders(
  tx: Db,
  datasetId: string,
  measures: Views["measures"],
): Promise<void> {
  if (measures.length === 0) return;
  const pairs = measures.map((m) => sql`(${m.name}::text, ${m.folder}::text)`);
  await tx.execute(
    sql`update ${powerbiMeasure} set display_folder = read.folder
        from (values ${sql.join(pairs, sql`, `)}) as read(name, folder)
        where ${powerbiMeasure.dataset_id} = ${datasetId}::uuid
          and ${powerbiMeasure.name} = read.name`,
  );
}

async function setColumnFolders(
  tx: Db,
  datasetId: string,
  columns: Views["columns"],
): Promise<void> {
  if (columns.length === 0) return;
  const triples = columns.map(
    (c) => sql`(${c.table}::text, ${c.name}::text, ${c.folder}::text)`,
  );
  await tx.execute(
    sql`update ${powerbiColumn} set display_folder = read.folder
        from ${powerbiTable}, (values ${sql.join(triples, sql`, `)}) as read(table_name, name, folder)
        where ${powerbiColumn.dataset_id} = ${datasetId}::uuid
          and ${powerbiTable.id} = ${powerbiColumn.table_id}
          and ${powerbiTable.name} = read.table_name
          and ${powerbiColumn.name} = read.name`,
  );
}
