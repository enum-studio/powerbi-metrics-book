import { randomUUID } from "node:crypto";
import { and, arrayContains, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ServiceContext } from "../../context.js";
import { queryLog } from "../../db/schema/queries.js";
import type { ThreadElement } from "../../db/schema/threads.js";
import {
  GAP_KINDS,
  request,
  searchLog,
  type GapKind,
  type RequestOutcome,
} from "../../db/schema/usage.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { writeAudit } from "../audit/write.js";
import { afterCursor, looksLikeId, pageBy, type Page } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { countRequest, type RateRule } from "../rate-limit.js";
import {
  checkedText,
  describes,
  elementSeen,
  resolveElement,
} from "../threads/threads.js";

/*
 * Requests: a question a person asked an agent, whether the book answered it
 * and what was missing, recorded by the agent after it answered. audit_writer
 * inserts them, so nothing changes one once written. request:read lets its
 * principal and curators read one, request:delete its principal and admins
 * delete one. An element, a query or a search the caller may not see answers
 * exactly like a missing one, in every function here.
 */

/** Per principal: an agent recording in a loop is stopped early. */
export const REQUEST_RATE: RateRule = { window_seconds: 60, max: 30 };
export const CAPTURE_OFF_NOTE =
  "Not recorded: this deployment keeps no requests (usage.capture is off).";
const TEXT_MAX = 2000;
const LINKS_MAX = 20;
const PAGE_SIZE = 20;
const PAGE_MAX = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RecordRequestInput = {
  question: string;
  outcome: RequestOutcome;
  gaps?: GapKind[];
  missing?: string;
  elements?: ThreadElement[];
  query_ids?: string[];
  search_ids?: string[];
};
export type RecordRequestAnswer =
  | { recorded: true; id: string; kept_until: string }
  | { recorded: false; note: string };

const invalid = (message: string) => new ServiceError("invalid", message);
const noSuchRequest = () => new ServiceError("not_found", "No such request.");

const resourceOf = (row: {
  id: string;
  principal_kind: string;
  principal_id: string;
}) => ({
  kind: "request" as const,
  id: row.id,
  attr: { principal_kind: row.principal_kind, principal_id: row.principal_id },
});

function checkGaps(outcome: RequestOutcome, gaps: readonly string[]): void {
  gaps.forEach((gap, index) => {
    if (!(GAP_KINDS as readonly string[]).includes(gap))
      throw invalid(
        `gaps[${String(index)}] is not one of ${GAP_KINDS.join(", ")}.`,
      );
    if (gaps.indexOf(gap) !== index) throw invalid(`gaps names ${gap} twice.`);
  });
  if (outcome !== "answered" && gaps.length === 0)
    throw invalid(`gaps needs at least one gap when outcome is ${outcome}.`);
}

/**
 * Each element with its id, resolved as a thread's element is. One that does
 * not resolve and one the caller may not describe get the same sentence, so
 * the answer says nothing about hidden elements.
 */
async function resolvedElements(
  context: ServiceContext,
  elements: readonly ThreadElement[],
): Promise<ThreadElement[]> {
  if (elements.length === 0) return [];
  const resolved: ThreadElement[] = [];
  for (const [index, element] of elements.entries()) {
    const unknown = invalid(
      `elements[${String(index)}] is no ${element.kind} you can see.`,
    );
    const found = await resolveElement(context, element).catch(
      (error: unknown) => {
        throw error instanceof ServiceError && error.kind === "not_found"
          ? unknown
          : error;
      },
    );
    if (!(await describes(context, found))) throw unknown;
    resolved.push({ kind: found.kind, id: found.id.toLowerCase() });
  }
  return resolved;
}

/** Another principal's id gets the sentence a missing one gets. */
async function ownIds(
  context: ServiceContext,
  name: "query_ids" | "search_ids",
  given: readonly string[],
): Promise<string[]> {
  const ids = given.map((id) => id.toLowerCase());
  const wellFormed = ids.filter(looksLikeId);
  const table = name === "query_ids" ? queryLog : searchLog;
  const { kind, id } = context.principal;
  const own =
    wellFormed.length === 0
      ? []
      : await context.db
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              inArray(table.id, wellFormed),
              eq(table.principal_kind, kind),
              eq(table.principal_id, id),
            ),
          );
  const found = new Set(own.map((row) => row.id));
  const index = ids.findIndex((one) => !found.has(one));
  if (index !== -1)
    throw invalid(
      `${name}[${String(index)}] is no ${name === "query_ids" ? "query" : "search"} of yours.`,
    );
  return ids;
}

export async function recordRequest(
  context: ServiceContext,
  input: RecordRequestInput,
): Promise<RecordRequestAnswer> {
  const { principal } = context;
  const id = randomUUID();
  const owner = { principal_kind: principal.kind, principal_id: principal.id };
  await context.access.require(
    principal,
    resourceOf({ id, ...owner }),
    "create",
  );
  const verdict = await countRequest(
    context.db,
    `record_request:${principal.kind}:${principal.id}`,
    REQUEST_RATE,
    context.clock(),
  );
  if (!verdict.allowed)
    throw new ServiceError(
      "rate_limited",
      `Too many requests recorded. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
    );
  if (!(await context.settings.get("usage.capture")))
    return { recorded: false, note: CAPTURE_OFF_NOTE };

  const { question, outcome, gaps = [], missing } = input;
  if (question.trim() === "") throw invalid("question is empty.");
  checkedText("question", question, TEXT_MAX);
  if (missing !== undefined) checkedText("missing", missing, TEXT_MAX);
  checkGaps(outcome, gaps);
  const links = {
    elements: input.elements ?? [],
    query_ids: input.query_ids ?? [],
    search_ids: input.search_ids ?? [],
  };
  for (const [name, list] of Object.entries(links))
    if (list.length > LINKS_MAX)
      throw invalid(`${name} holds at most ${String(LINKS_MAX)}.`);
  const elements = await resolvedElements(context, links.elements);
  const query_ids = await ownIds(context, "query_ids", links.query_ids);
  const search_ids = await ownIds(context, "search_ids", links.search_ids);

  const at = context.clock();
  // audit_writer inserts and nothing else, so the insert returns nothing.
  await context.auditDb.insert(request).values({
    id,
    at,
    ...owner,
    via: principal.via,
    client_id: principal.client_id,
    question,
    outcome,
    gaps,
    missing: missing ?? null,
    elements,
    query_ids,
    search_ids,
  });
  const days = await context.settings.get("usage.retention_days");
  return {
    recorded: true,
    id,
    kept_until: new Date(at.getTime() + days * DAY_MS).toISOString(),
  };
}

/** A request's columns as one reader sees them: its elements only those the reader may see. */
async function shownTo(context: ServiceContext) {
  const { db, principal } = context;
  const allowed = await context.access.describableDatasets(principal);
  const hides = !(await readsPii(context));
  const element = {
    kind: sql`e.value->>'kind'`,
    id: sql`(e.value->>'id')::uuid`,
  };
  return {
    id: request.id,
    at: request.at,
    principal_kind: request.principal_kind,
    principal_id: request.principal_id,
    via: request.via,
    question: request.question,
    outcome: request.outcome,
    gaps: request.gaps,
    missing: request.missing,
    elements: sql<
      ThreadElement[]
    >`(select coalesce(jsonb_agg(e.value order by e.position), '[]'::jsonb)
      from jsonb_array_elements(${request.elements}) with ordinality as e(value, position)
      where ${elementSeen(db, allowed, element, false, hides)})`,
    query_ids: request.query_ids,
    search_ids: request.search_ids,
  };
}
type Row = Omit<
  typeof request.$inferSelect,
  "client_id" | "elements" | "search_tsv"
> & { elements: ThreadElement[] };

function entryOf(row: Row) {
  const { id, principal_kind, principal_id, at, ...rest } = row;
  return {
    id,
    at: at.toISOString(),
    principal: { kind: principal_kind, id: principal_id },
    ...rest,
  };
}
export type RequestEntry = ReturnType<typeof entryOf>;

export type RequestFilters = {
  mine?: boolean;
  outcome?: RequestOutcome;
  gap?: GapKind;
  since?: Date;
  /** Words in the question or missing. */
  text?: string;
  /** The next_cursor of the page before. */
  cursor?: string;
  limit?: number;
};

const own = ({ kind, id }: Principal) =>
  and(eq(request.principal_kind, kind), eq(request.principal_id, id));
/** Newest first, so a list is ordered by the request's time and id, and its cursor holds both. */
const newestFirst = { descending: true, name: z.iso.datetime() };

/**
 * Newest first. request:read is a condition of the SQL, as the query log's
 * query_log:read is: a page, its cursor and whether more follow come only
 * from requests the caller may read.
 */
export async function listRequests(
  context: ServiceContext,
  filters: RequestFilters = {},
): Promise<Page<RequestEntry>> {
  const { principal } = context;
  const limit = filters.limit ?? PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
    throw invalid(`limit is a whole number from 1 to ${String(PAGE_MAX)}.`);
  const rows = await context.db
    .select(await shownTo(context))
    .from(request)
    .where(
      and(
        filters.mine === true ? own(principal) : undefined,
        filters.outcome === undefined
          ? undefined
          : eq(request.outcome, filters.outcome),
        filters.gap === undefined
          ? undefined
          : arrayContains(request.gaps, [filters.gap]),
        filters.since === undefined
          ? undefined
          : gte(request.at, filters.since),
        filters.text === undefined
          ? undefined
          : sql`${request.search_tsv} @@ websearch_to_tsquery('simple', ${filters.text})`,
        afterCursor(
          { name: request.at, id: request.id },
          filters.cursor,
          newestFirst,
        ),
        await context.access.readableRequests(principal),
      ),
    )
    .orderBy(desc(request.at), desc(request.id))
    .limit(limit + 1);
  const page = pageBy(rows, limit, (row) => row.at.toISOString());
  return { items: page.items.map(entryOf), next_cursor: page.next_cursor };
}

/** The request the caller may read, or not_found as for a missing one. */
async function readable(context: ServiceContext, id: string): Promise<Row> {
  if (!looksLikeId(id)) throw noSuchRequest();
  const [row] = await context.db
    .select(await shownTo(context))
    .from(request)
    .where(eq(request.id, id));
  if (
    row === undefined ||
    !(await context.access.check(context.principal, resourceOf(row), "read"))
  )
    throw noSuchRequest();
  return row;
}

/** One request, with each linked query and search the caller may read. */
export async function getRequest(context: ServiceContext, id: string) {
  const { db, principal } = context;
  const row = await readable(context, id);
  const queries =
    row.query_ids.length === 0
      ? []
      : await db
          .select({
            id: queryLog.id,
            dataset_id: queryLog.dataset_id,
            dataset_name: queryLog.dataset_name,
            status: queryLog.status,
            metric_ids: queryLog.metric_ids,
          })
          .from(queryLog)
          .where(
            and(
              inArray(queryLog.id, row.query_ids),
              await context.access.readableQueryLog(principal),
            ),
          );
  const searches =
    row.search_ids.length === 0
      ? []
      : await db
          .select({
            id: searchLog.id,
            query: searchLog.query,
            hit_count: searchLog.hit_count,
          })
          .from(searchLog)
          .where(
            and(
              inArray(searchLog.id, row.search_ids),
              await context.access.readableSearchLog(principal),
            ),
          );
  const inOrder = <T extends { id: string }>(ids: string[], found: T[]) =>
    ids.flatMap((one) => found.filter((item) => item.id === one));
  return {
    ...entryOf(row),
    queries: inOrder(row.query_ids, queries).map(
      ({ dataset_id, dataset_name, ...query }) => ({
        id: query.id,
        dataset:
          dataset_id === null
            ? null
            : { kind: "dataset" as const, id: dataset_id, name: dataset_name },
        status: query.status,
        metric_ids: query.metric_ids,
      }),
    ),
    searches: inOrder(row.search_ids, searches),
  };
}

/** Deletes one request: its principal's own, or any for an admin. A curator who reads it is refused. */
export async function deleteRequest(
  context: ServiceContext,
  id: string,
): Promise<void> {
  const { principal } = context;
  const row = await readable(context, id);
  await context.access.require(principal, resourceOf(row), "delete");
  await writeAudit(context, {
    principal,
    action: "request.delete",
    resource: { kind: "request", id: row.id },
    decision: "allow",
    detail: {
      principal_kind: row.principal_kind,
      principal_id: row.principal_id,
    },
  });
  await context.db.delete(request).where(eq(request.id, row.id));
}
