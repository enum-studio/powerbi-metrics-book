import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  notExists,
  notLike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db, ServiceContext } from "../../context.js";
import { metric, metricVariant } from "../../db/schema/book.js";
import { event, type EventKind } from "../../db/schema/events.js";
import { powerbiDataset, powerbiMeasure } from "../../db/schema/mirror.js";
import { thread } from "../../db/schema/threads.js";
import { chunks, ROWS_PER_STATEMENT } from "../../db/statements.js";
import type { Principal } from "../../principal.js";
import { mayAdmin } from "../admin/guard.js";
import { visibleMetric } from "../mirror/read.js";
import { piiMeasure, readsPii } from "../pii/rules.js";
import { elementSeen } from "../threads/threads.js";

/** A page of the feed is never longer than this, whatever a reader asks for. */
export const EVENT_PAGE_MAX = 500;
export const EVENT_RETENTION_DAYS = 90;

export type EventRow = typeof event.$inferSelect;

export const EVENT_LOCK_NAME = "powerbi_metrics_book.event";

export type NewEvent = {
  kind: EventKind;
  element_kind: string | null;
  element_id: string | null;
  /** Null for the sync, which has no principal. */
  principal: Principal | null;
  data: Record<string, unknown>;
};

/**
 * Runs `work` in one transaction and writes the events it emitted with that
 * transaction, so a change and its events stand or fall together. Call it
 * once, outermost: inside a transaction already open it would only make a
 * savepoint, and the events would not be the last write.
 *
 * A reader keeps the last id it saw and asks for what came after, so an id
 * must never become visible before a lower one. Inserting under a lock makes
 * events queue and commit in id order. The lock is taken only after `work`
 * has finished and only the events' inserts follow it, so the transaction
 * holds it just until it commits and waits for nothing else meanwhile: a
 * transaction that took it earlier could wait for a row another holds while
 * that one waits for the lock, and Postgres would abort one.
 */
export async function withEvents<T>(
  db: Db,
  work: (tx: Db, emit: (event: NewEvent) => void) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const emitted: NewEvent[] = [];
    const result = await work(tx, (newEvent) => {
      emitted.push(newEvent);
    });
    if (emitted.length > 0) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${EVENT_LOCK_NAME}, 0))`,
      );
      // One drafter run on a large dataset emits more than a statement can bind.
      for (const part of chunks(emitted, ROWS_PER_STATEMENT))
        await tx.insert(event).values(
          part.map((newEvent) => ({
            kind: newEvent.kind,
            element_kind: newEvent.element_kind,
            element_id: newEvent.element_id,
            principal_kind: newEvent.principal?.kind ?? null,
            principal_id: newEvent.principal?.id ?? null,
            data: newEvent.data,
          })),
        );
    }
    return result;
  });
}

export type EventQuery = {
  after?: number;
  kinds?: readonly EventKind[];
  limit?: number;
};

/**
 * Oldest first, the events after id `after` (all when omitted), of the given
 * kinds (every kind when omitted; an empty list matches none), and `where`
 * when given, which narrows the events before the limit counts them.
 */
export function readEvents(
  db: Db,
  query: EventQuery & { where?: SQL },
): Promise<EventRow[]> {
  const conditions = [gt(event.id, query.after ?? 0)];
  if (query.where !== undefined) conditions.push(query.where);
  if (query.kinds !== undefined) {
    conditions.push(inArray(event.kind, [...query.kinds]));
  }
  return db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(asc(event.id))
    .limit(Math.min(query.limit ?? EVENT_PAGE_MAX, EVENT_PAGE_MAX));
}

/**
 * The feed as one caller may read it. An event names its element, and the
 * caller sees it when it may describe that element: a metric by the datasets
 * its event recorded and, while the metric exists, as the metric services
 * show it now, and when it names a variant, only if that variant's measure is
 * known to be shown; a variant through the dataset its event records; a term and
 * the conventions as everyone does. An event naming no element is shown only
 * if it is a sync event the caller may read. A thread's event shows to
 * whoever may see the thread's own element. An element of any other kind is
 * never shown: what is not known to be visible is hidden. A sync event
 * carries its error only to a caller who may manage the settings.
 */
export async function readVisibleEvents(
  context: ServiceContext,
  query: EventQuery,
): Promise<EventRow[]> {
  const { db } = context;
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const asText = (id: SQL) => sql<string>`${id}::text`;
  const datasets = db
    .select({ id: asText(sql`${powerbiDataset.id}`) })
    .from(powerbiDataset)
    .where(allowed);
  const metrics = db
    .select({ id: asText(sql`${metric.id}`) })
    .from(metric)
    .where(visibleMetric(db, allowed, hides));
  const threads = db
    .select({ id: asText(sql`${thread.id}`) })
    .from(thread)
    .where(
      elementSeen(
        db,
        allowed,
        { kind: sql`${thread.element_kind}`, id: sql`${thread.element_id}` },
        false,
        hides,
      ),
    );
  const metricGone = notExists(
    db
      .select({ one: sql`1` })
      .from(metric)
      .where(sql`${metric.id}::text = ${event.element_id}`),
  );
  // The one rule for a recorded measure: its dataset is describable and, for a reader without PII, it is not PII.
  const measureShown = sql`${powerbiMeasure.dataset_id}::text in ${datasets}
    ${hides ? sql`and not ${piiMeasure(powerbiMeasure)}` : sql``}`;
  const listed = sql`jsonb_array_elements_text(case jsonb_typeof(${event.data} -> 'measure_ids')
    when 'array' then ${event.data} -> 'measure_ids' else '[]'::jsonb end) as recorded(id)`;
  const emptyList = sql`${event.data} -> 'measure_ids' = '[]'::jsonb`;
  // A reader of PII needs a shown measure only when the event recorded one; rows from before the list was written carry none.
  const noList = hides
    ? sql`(${emptyList} and ${event.data} -> 'dataset_ids' = '[]'::jsonb)`
    : sql`(jsonb_typeof(${event.data} -> 'measure_ids') is distinct from 'array' or ${emptyList})`;
  const recordedMeasuresVisible = sql`(${noList} or exists (
    select 1 from ${listed}
    inner join ${powerbiMeasure} on ${powerbiMeasure.id}::text = recorded.id
    where ${measureShown}
  ))`;
  // A change to a variant tells where a measure was filed, so it shows only when that measure is known to be shown. A variant now gone is known only when every measure the row recorded is shown.
  const isNamedVariant = sql`${metricVariant.id}::text = ${event.data} ->> 'variant_id'`;
  const namedVariantShown = sql`(${event.data} ->> 'variant_id' is null or exists (
    select 1 from ${metricVariant}
    inner join ${powerbiMeasure} on ${powerbiMeasure.id} = ${metricVariant.measure_id}
    where ${isNamedVariant} and ${measureShown}
  ) or (not exists (select 1 from ${metricVariant} where ${isNamedVariant}) and not exists (
    select 1 from ${listed}
    where not exists (
      select 1 from ${powerbiMeasure}
      where ${powerbiMeasure.id}::text = recorded.id and ${measureShown}
    )
  )))`;
  // No list recorded hides the event; an empty one means everyone, as visibleMetric has it. A metric that still exists must also be visible now.
  const recordedScope = sql`(jsonb_typeof(${event.data} -> 'dataset_ids') = 'array'
    and (jsonb_array_length(${event.data} -> 'dataset_ids') = 0
      or exists (select 1 from jsonb_array_elements_text(${event.data} -> 'dataset_ids') as scope(id)
        where scope.id in ${datasets})))`;
  const seen = or(
    and(isNull(event.element_kind), like(event.kind, "sync.%")),
    inArray(event.element_kind, ["term", "conventions"]),
    and(
      eq(event.element_kind, "metric"),
      recordedScope,
      recordedMeasuresVisible,
      namedVariantShown,
      or(metricGone, inArray(event.element_id, metrics)),
    ),
    and(eq(event.element_kind, "thread"), inArray(event.element_id, threads)),
    and(
      eq(event.element_kind, "variant"),
      inArray(sql<string>`${event.data} ->> 'dataset_id'`, datasets),
      hides
        ? sql`exists (
            select 1 from ${powerbiMeasure}
            where ${powerbiMeasure.id}::text = ${event.data} ->> 'measure_id'
              and not ${piiMeasure(powerbiMeasure)}
          )`
        : undefined,
    ),
  );
  const mayReadSync = await mayAdmin(context, "read_sync_events");
  const mayReadErrors =
    mayReadSync && (await mayAdmin(context, "manage_settings"));
  const rows = await readEvents(db, {
    ...query,
    where: and(seen, mayReadSync ? undefined : notLike(event.kind, "sync.%")),
  });
  const shown = await describableMeasureIds(db, rows, measureShown);
  const reachable = await describableDatasetIds(db, rows, allowed);
  return rows.map((row) => {
    const data = withoutHiddenIds(row.data, shown, hides, reachable);
    return mayReadErrors || !row.kind.startsWith("sync.")
      ? { ...row, data }
      : {
          ...row,
          data: Object.fromEntries(
            Object.entries(data).filter(([key]) => key !== "error"),
          ),
        };
  });
}

/** The ids a metric event recorded under one key, or null when it records none. */
const recordedIds = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : null;

/** Of the measure ids the rows record, those `rule` lets the caller describe, each with its dataset. */
async function describableMeasureIds(
  db: Db,
  rows: EventRow[],
  rule: SQL,
): Promise<Map<string, string>> {
  const recorded = [
    ...new Set(rows.flatMap((row) => recordedIds(row.data.measure_ids) ?? [])),
  ];
  if (recorded.length === 0) return new Map();
  const found = await db
    .select({ id: powerbiMeasure.id, dataset_id: powerbiMeasure.dataset_id })
    .from(powerbiMeasure)
    .where(
      and(
        sql`${powerbiMeasure.id}::text = any(${sql.param(recorded)}::text[])`,
        rule,
      ),
    );
  return new Map(found.map(({ id, dataset_id }) => [id, dataset_id]));
}

/** Of the dataset ids the rows record, those the caller may describe. */
async function describableDatasetIds(
  db: Db,
  rows: EventRow[],
  allowed: SQL,
): Promise<Set<string>> {
  const recorded = [
    ...new Set(rows.flatMap((row) => recordedIds(row.data.dataset_ids) ?? [])),
  ];
  if (recorded.length === 0) return new Set();
  const found = await db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(
      and(
        sql`${powerbiDataset.id}::text = any(${sql.param(recorded)}::text[])`,
        allowed,
      ),
    );
  return new Set(found.map(({ id }) => id));
}

/**
 * A metric event's lists, cut by that event's own ids: its measures to those
 * the caller is shown, and its datasets to those the caller may describe. For
 * a reader without PII, only the datasets of the measures left on this event,
 * so a dataset held only by hidden measures is not named.
 */
function withoutHiddenIds(
  data: EventRow["data"],
  shown: Map<string, string>,
  hides: boolean,
  reachable: Set<string>,
): EventRow["data"] {
  const measures = recordedIds(data.measure_ids)?.filter((id) => shown.has(id));
  const ofRow = new Set(measures?.map((id) => shown.get(id)));
  const datasets = recordedIds(data.dataset_ids)?.filter((id) =>
    hides ? ofRow.has(id) : reachable.has(id),
  );
  return {
    ...data,
    ...(measures === undefined ? {} : { measure_ids: measures }),
    ...(datasets === undefined ? {} : { dataset_ids: datasets }),
  };
}

/** Returns how many it deleted. The worker runs it: no other role may delete from event. */
export async function deleteOldEvents(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const deleted = await db
    .delete(event)
    .where(lt(event.at, cutoff))
    .returning({ id: event.id });
  return deleted.length;
}
