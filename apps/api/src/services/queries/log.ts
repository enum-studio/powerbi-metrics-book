import { createHash } from "node:crypto";
import {
  and,
  arrayContains,
  arrayOverlaps,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import type { ServiceContext } from "../../context.js";
import { metric } from "../../db/schema/book.js";
import { powerbiWorkspace } from "../../db/schema/mirror.js";
import {
  queryLog,
  type QueryOrigin,
  type QueryStatus,
} from "../../db/schema/queries.js";
import { ServiceError } from "../../errors.js";
import { looksLikeId, type Page } from "../mirror/read.js";

/*
 * The query log: one row per query, whatever its outcome, inserted by
 * audit_writer after the query ends. It holds the DAX and the purpose, never
 * a result row. Who reads which entry is query_log:read.
 */

/** What a log entry keeps of a text: the query service refuses longer DAX, and this bound holds for a refused query too. */
const LOGGED_BYTES_MAX = 100 * 1024;
/** What search shows of the DAX and the purpose; get_query gives the rest. */
const SHOWN_CHARS = 2000;
const PAGE_SIZE = 20;
const PAGE_MAX = 100;

/** Postgres text cannot hold NUL, so a refused query's input is logged with U+FFFD in its place, and cut to the bound. */
function storable(text: string): string {
  const clean = text.replaceAll("\0", "�");
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.length <= LOGGED_BYTES_MAX) return clean;
  return bytes.subarray(0, LOGGED_BYTES_MAX).toString("utf8");
}
const storableOrNull = (text: string | null) =>
  text === null ? null : storable(text);

export type QueryLogInput = {
  id: string;
  powerbi_account?: string | null;
  origin?: QueryOrigin;
  at: Date;
  dataset: { id: string; name: string; workspace_id: string } | null;
  dax: string;
  purpose: string | null;
  status: QueryStatus;
  error: string | null;
  duration_ms: number;
  measure_names: string[];
  metric_ids: string[];
  result?: {
    id: string;
    row_count: number;
    column_count: number;
    bytes: number;
    expires_at: Date;
  };
};

export async function logQuery(
  context: ServiceContext,
  entry: QueryLogInput,
): Promise<void> {
  const { dataset, result } = entry;
  // audit_writer inserts and nothing else, so the insert returns nothing.
  await context.auditDb.insert(queryLog).values({
    id: entry.id,
    origin: entry.origin,
    at: entry.at,
    principal_kind: context.principal.kind,
    principal_id: context.principal.id,
    via: context.principal.via,
    client_id: context.principal.client_id,
    powerbi_account: entry.powerbi_account ?? null,
    dataset_id: dataset?.id ?? null,
    dataset_name: dataset?.name ?? null,
    workspace_id: dataset?.workspace_id ?? null,
    dax: storable(entry.dax),
    // Of the DAX as sent, so a query cut to fit still matches its own hash.
    dax_hash: createHash("sha256").update(entry.dax).digest("hex"),
    purpose: storableOrNull(entry.purpose),
    status: entry.status,
    error: storableOrNull(entry.error),
    row_count: result?.row_count ?? null,
    column_count: result?.column_count ?? null,
    bytes: result?.bytes ?? null,
    duration_ms: entry.duration_ms,
    result_id: result?.id ?? null,
    result_expires_at: result?.expires_at ?? null,
    measure_names: entry.measure_names,
    metric_ids: entry.metric_ids,
  });
}

export type QueryLogFilters = {
  /** Words of the DAX, the purpose or the dataset name. */
  text?: string;
  /** An id or a name. */
  dataset?: string;
  workspace?: string;
  metric?: string;
  /** The principal's id. */
  principal?: string;
  mine?: boolean;
  status?: QueryStatus;
  origins?: QueryOrigin[];
  since?: Date;
  until?: Date;
  /** The next_cursor of the page before. */
  cursor?: string;
  limit?: number;
};

const shown = {
  id: queryLog.id,
  origin: queryLog.origin,
  at: queryLog.at,
  principal_kind: queryLog.principal_kind,
  principal_id: queryLog.principal_id,
  via: queryLog.via,
  client_id: queryLog.client_id,
  dataset_id: queryLog.dataset_id,
  dataset_name: queryLog.dataset_name,
  workspace_id: queryLog.workspace_id,
  status: queryLog.status,
  error: queryLog.error,
  row_count: queryLog.row_count,
  column_count: queryLog.column_count,
  duration_ms: queryLog.duration_ms,
  result_id: queryLog.result_id,
  measure_names: queryLog.measure_names,
  metric_ids: queryLog.metric_ids,
};
type Row = Omit<
  typeof queryLog.$inferSelect,
  | "dax"
  | "dax_hash"
  | "purpose"
  | "bytes"
  | "result_expires_at"
  | "search_tsv"
  | "powerbi_account"
>;
type Texts = {
  dax: string;
  dax_cut: boolean;
  purpose: string | null;
  purpose_cut: boolean;
};

const ownEntry = (context: ServiceContext, row: Row) =>
  row.principal_kind === context.principal.kind &&
  row.principal_id === context.principal.id;

function entryOf(context: ServiceContext, row: Row, texts: Texts) {
  const { principal_kind, principal_id, dataset_id, dataset_name, ...rest } =
    row;
  return {
    kind: "query" as const,
    ...rest,
    at: row.at.toISOString(),
    principal: { kind: principal_kind, id: principal_id },
    dataset:
      dataset_id === null
        ? null
        : { kind: "dataset" as const, id: dataset_id, name: dataset_name },
    ...texts,
    // Power BI's sentence can quote what the query read; others see the status alone.
    error: ownEntry(context, row) ? row.error : null,
  };
}
export type QueryLogEntry = ReturnType<typeof entryOf>;

/** Whether query_log:read lets the principal see the entry. A search asks the same in its SQL: a resource attribute added here goes into plan.ts too. */
const readable = (context: ServiceContext, row: Row) =>
  context.access.check(
    context.principal,
    {
      kind: "query_log",
      id: row.id,
      attr: {
        principal_kind: row.principal_kind,
        principal_id: row.principal_id,
      },
    },
    "read",
  );

const cursorSchema = z.tuple([z.iso.datetime(), z.guid()]);

function afterCursor(cursor: string | undefined): SQL | undefined {
  if (cursor === undefined) return undefined;
  const parsed = cursorSchema.safeParse(
    Buffer.from(cursor, "base64url").toString("utf8").split("|"),
  );
  if (!parsed.success)
    throw new ServiceError(
      "invalid",
      "cursor is not a next_cursor this log gave.",
    );
  const [at, id] = parsed.data;
  return or(
    lt(queryLog.at, new Date(at)),
    and(eq(queryLog.at, new Date(at)), lt(queryLog.id, id)),
  );
}

/**
 * Newest first. query_log:read is a condition of the SQL, as a list of
 * datasets filters by dataset:describe: a page, its cursor and whether more
 * follow come only from entries the principal may read, so an entry a policy
 * hides leaves no trace in the answer, whatever words or limit are asked.
 */
export async function searchQueryLog(
  context: ServiceContext,
  filters: QueryLogFilters = {},
): Promise<Page<QueryLogEntry>> {
  const { principal } = context;
  const limit = filters.limit ?? PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
    throw new ServiceError(
      "invalid",
      `limit is a whole number from 1 to ${String(PAGE_MAX)}.`,
    );
  const { dataset, workspace, metric: named } = filters;
  const conditions = [
    filters.origins === undefined
      ? undefined
      : inArray(queryLog.origin, filters.origins),
    filters.text === undefined
      ? undefined
      : sql`${queryLog.search_tsv} @@ websearch_to_tsquery('simple', ${filters.text})`,
    dataset === undefined
      ? undefined
      : looksLikeId(dataset)
        ? eq(queryLog.dataset_id, dataset)
        : eq(queryLog.dataset_name, dataset),
    workspace === undefined
      ? undefined
      : looksLikeId(workspace)
        ? eq(queryLog.workspace_id, workspace)
        : inArray(
            queryLog.workspace_id,
            context.db
              .select({ id: powerbiWorkspace.id })
              .from(powerbiWorkspace)
              .where(eq(powerbiWorkspace.name, workspace)),
          ),
    named === undefined
      ? undefined
      : looksLikeId(named)
        ? arrayContains(queryLog.metric_ids, [named])
        : arrayOverlaps(
            queryLog.metric_ids,
            sql`array(${context.db.select({ id: metric.id }).from(metric).where(eq(metric.name, named))})`,
          ),
    filters.principal === undefined
      ? undefined
      : eq(queryLog.principal_id, filters.principal),
    filters.mine === true
      ? and(
          eq(queryLog.principal_kind, principal.kind),
          eq(queryLog.principal_id, principal.id),
        )
      : undefined,
    filters.status === undefined
      ? undefined
      : eq(queryLog.status, filters.status),
    filters.since === undefined ? undefined : gte(queryLog.at, filters.since),
    filters.until === undefined ? undefined : lt(queryLog.at, filters.until),
    afterCursor(filters.cursor),
    await context.access.readableQueryLog(principal),
  ];
  const rows = await context.db
    .select({
      ...shown,
      dax: sql<string>`left(${queryLog.dax}, ${SHOWN_CHARS})`,
      dax_cut: sql<boolean>`length(${queryLog.dax}) > ${SHOWN_CHARS}`,
      purpose: sql<string | null>`left(${queryLog.purpose}, ${SHOWN_CHARS})`,
      purpose_cut: sql<boolean>`coalesce(length(${queryLog.purpose}) > ${SHOWN_CHARS}, false)`,
    })
    .from(queryLog)
    .where(and(...conditions))
    .orderBy(desc(queryLog.at), desc(queryLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ dax, dax_cut, purpose, purpose_cut, ...row }) =>
      entryOf(context, row, { dax, dax_cut, purpose, purpose_cut }),
    ),
    next_cursor:
      rows.length > limit && last !== undefined
        ? Buffer.from(`${last.at.toISOString()}|${last.id}`).toString(
            "base64url",
          )
        : null,
  };
}

/** One entry with its whole DAX and purpose. An entry the principal may not read answers like a missing one. */
export async function getQuery(
  context: ServiceContext,
  id: string,
): Promise<QueryLogEntry> {
  const missing = new ServiceError("not_found", "No such query.");
  if (!looksLikeId(id)) throw missing;
  const [row] = await context.db
    .select({ ...shown, dax: queryLog.dax, purpose: queryLog.purpose })
    .from(queryLog)
    .where(eq(queryLog.id, id));
  if (row === undefined || !(await readable(context, row))) throw missing;
  const { dax, purpose, ...rest } = row;
  return entryOf(context, rest, {
    dax,
    dax_cut: false,
    purpose,
    purpose_cut: false,
  });
}
