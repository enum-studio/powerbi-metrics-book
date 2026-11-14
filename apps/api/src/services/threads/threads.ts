import { requireQuestions } from "./open-questions.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  not,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db, Resource, ServiceContext } from "../../context.js";
import { category, metric, metricVariant, term } from "../../db/schema/book.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import {
  THREAD_BODY_MAX,
  THREAD_TITLE_MAX,
  thread,
  threadReply,
  threadUpvote,
  threadView,
  type ThreadElement,
  type ThreadElementKind,
  type THREAD_ACCEPTED_BY,
  type THREAD_KINDS,
  type THREAD_STATUSES,
} from "../../db/schema/threads.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import { excerpt } from "../text.js";
import type { Principal } from "../../principal.js";
import { namesOf, REMOVED_PERSON, whoKey } from "../auth/people.js";
import { loadTree } from "../book/categories.js";
import { resolveMetric } from "../book/metrics.js";
import { resolveTerm } from "../book/terms.js";
import { type NewEvent, withEvents } from "../events/feed.js";
import {
  afterCursor,
  looksLikeId,
  pageBy,
  sizeOf,
  unlessPii,
  visibleMetric,
} from "../mirror/read.js";
import { piiColumn, piiMeasure, readsPii } from "../pii/rules.js";
import { acceptedByOf } from "./open-questions.js";

/*
 * Questions and comments on any element. A thread is seen by the callers who
 * may see its element, as that element's own service shows it, and answers
 * exactly like a missing one to everyone else, in every function here. What a
 * thread names is its element's kind and id and its authors' kind and id,
 * which a caller who sees the thread may have.
 */

type ThreadKind = (typeof THREAD_KINDS)[number];
type ThreadStatus = (typeof THREAD_STATUSES)[number];
type Emit = (event: NewEvent) => void;

const invalid = (message: string) => new ServiceError("invalid", message);
const missing = () => new ServiceError("not_found", "No such thread.");

/** What a list shows of a body; get_thread has it all. */
const EXCERPT = 300;

/**
 * A thread as one caller sees it: its fields and the counts, which are
 * correlated subqueries so every select of it carries them. `unread_replies`
 * are the replies by others since the caller last viewed the thread. An
 * upvote or a view belongs to a principal of one kind and id.
 */
const anchorColumns = ({ kind, id }: Principal) => ({
  id: thread.id,
  kind: thread.kind,
  element_kind: thread.element_kind,
  element_id: thread.element_id,
  title: thread.title,
  author_kind: thread.author_kind,
  author_id: thread.author_id,
  status: thread.status,
  accepted_reply_id: thread.accepted_reply_id,
  accepted_by_role: thread.accepted_by_role,
  accepted_by_kind: thread.accepted_by_kind,
  accepted_by_via: thread.accepted_by_via,
  created_at: thread.created_at,
  updated_at: thread.updated_at,
  reply_count: sql<number>`(select count(*) from ${threadReply} r where r.thread_id = ${thread}.id)::int`,
  unread_replies: sql<number>`(select count(*) from ${threadReply} r
    left join ${threadView} v on v.thread_id = r.thread_id and v.principal_kind = ${kind} and v.principal_id = ${id}
    where r.thread_id = ${thread}.id and not (r.author_kind = ${kind} and r.author_id = ${id})
      and (v.viewed_at is null or r.created_at > v.viewed_at))::int`,
  upvote_count: sql<number>`(select count(*) from ${threadUpvote} u where u.thread_id = ${thread}.id)::int`,
  upvoted: sql<boolean>`exists (select 1 from ${threadUpvote} u
    where u.thread_id = ${thread}.id and u.principal_kind = ${kind} and u.principal_id = ${id})`,
});

/** Puts a thread's element and author as the wire has them. */
function shape<
  Row extends {
    element_kind: ThreadElementKind;
    element_id: string;
    author_kind: Principal["kind"];
    author_id: string;
    accepted_reply_id: string | null;
    accepted_by_role: (typeof THREAD_ACCEPTED_BY)[number] | null;
    accepted_by_kind: Principal["kind"] | null;
    accepted_by_via: Principal["via"] | null;
  },
>(row: Row) {
  const {
    element_kind,
    element_id,
    author_kind,
    author_id,
    accepted_by_role,
    accepted_by_kind,
    accepted_by_via,
    ...rest
  } = row;
  return {
    ...rest,
    ...acceptedByOf({
      accepted_reply_id: rest.accepted_reply_id,
      accepted_by_role,
      accepted_by_kind,
      accepted_by_via,
    }),
    element: { kind: element_kind, id: element_id },
    author: { kind: author_kind, id: author_id },
  };
}

const authorOf = (principal: Principal) => ({
  author_kind: principal.kind,
  author_id: principal.id,
});
const principalOf = (principal: Principal) => ({
  principal_kind: principal.kind,
  principal_id: principal.id,
});

/** The resource Cerbos rules on; `thread_author` compares both author fields. */
const resourceOf = (row: {
  id: string;
  kind: ThreadKind;
  status: ThreadStatus;
  author_kind: Principal["kind"];
  author_id: string;
}): Resource => ({
  kind: "thread",
  id: row.id,
  attr: {
    author_id: row.author_id,
    author_kind: row.author_kind,
    kind: row.kind,
    status: row.status,
  },
});

/**
 * Whether an element is one the caller may see, as SQL over an element's
 * `kind` and `id` (a thread's own columns, or one asked about). Mirror
 * elements are seen through their dataset, a metric and a term as their
 * services show them, a category by everyone. A query has no case yet: the
 * query log is built apart, and until its case is here no thread is on one.
 * `live` leaves out what the sync saw go.
 */
export function elementSeen(
  db: Db,
  allowed: SQL,
  element: { kind: SQL; id: SQL },
  live: boolean,
  hidesPii: boolean,
): SQL {
  const alive = (target: { removed_at: PgColumn }) =>
    live ? isNull(target.removed_at) : undefined;
  const datasets = db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(and(allowed, alive(powerbiDataset)));
  const inDataset = (
    target: PgTable & {
      id: PgColumn;
      dataset_id: PgColumn;
      removed_at: PgColumn;
    },
  ) =>
    inArray(
      element.id,
      db
        .select({ id: target.id })
        .from(target)
        .where(and(alive(target), inArray(target.dataset_id, datasets))),
    );
  // A PII column or measure is no element to a caller who may not read PII.
  const unlessPiiIn = (
    target: typeof powerbiColumn | typeof powerbiMeasure,
    pii: SQL,
  ) =>
    inArray(
      element.id,
      db
        .select({ id: target.id })
        .from(target)
        .innerJoin(powerbiTable, eq(powerbiTable.id, target.table_id))
        .where(
          and(
            alive(target),
            inArray(target.dataset_id, datasets),
            hidesPii ? not(pii) : undefined,
          ),
        ),
    );
  const cases: [string, SQL][] = [
    [
      "workspace",
      inArray(
        element.id,
        db
          .select({ id: powerbiWorkspace.id })
          .from(powerbiWorkspace)
          .innerJoin(
            powerbiDataset,
            eq(powerbiDataset.workspace_id, powerbiWorkspace.id),
          )
          .where(and(allowed, alive(powerbiWorkspace), alive(powerbiDataset))),
      ),
    ],
    ["dataset", inArray(element.id, datasets)],
    ["table", inDataset(powerbiTable)],
    [
      "column",
      unlessPiiIn(powerbiColumn, piiColumn(powerbiColumn, powerbiTable)),
    ],
    ["measure", unlessPiiIn(powerbiMeasure, piiMeasure(powerbiMeasure))],
    [
      "metric",
      inArray(
        element.id,
        db
          .select({ id: metric.id })
          .from(metric)
          .where(visibleMetric(db, allowed, hidesPii)),
      ),
    ],
    [
      "variant",
      inArray(
        element.id,
        db
          .select({ id: metricVariant.id })
          .from(metricVariant)
          .innerJoin(
            powerbiMeasure,
            eq(powerbiMeasure.id, metricVariant.measure_id),
          )
          .where(
            and(
              alive(powerbiMeasure),
              inArray(powerbiMeasure.dataset_id, datasets),
              unlessPii(hidesPii),
            ),
          ),
      ),
    ],
    ["term", inArray(element.id, db.select({ id: term.id }).from(term))],
    [
      "category",
      inArray(element.id, db.select({ id: category.id }).from(category)),
    ],
  ];
  return sql`(${sql.join(
    cases.map(([kind, seen]) => sql`(${element.kind} = ${kind} and ${seen})`),
    sql` or `,
  )})`;
}

const threadsSeen = (db: Db, allowed: SQL, hidesPii: boolean) =>
  elementSeen(
    db,
    allowed,
    { kind: sql`${thread.element_kind}`, id: sql`${thread.element_id}` },
    false,
    hidesPii,
  );

async function findThread(
  db: Db,
  principal: Principal,
  allowed: SQL,
  hidesPii: boolean,
  id: string,
  lock = false,
) {
  if (!looksLikeId(id)) throw missing();
  const query = db
    .select({ ...anchorColumns(principal), body: thread.body })
    .from(thread)
    .where(and(eq(thread.id, id), threadsSeen(db, allowed, hidesPii)));
  const [found] = await (lock ? query.for("update") : query);
  if (found === undefined) throw missing();
  return found;
}

type Anchor = Awaited<ReturnType<typeof findThread>>;

/** A body or title is stored as it was written; this only refuses what cannot be stored or read. */
export function checkedText(label: string, text: string, max: number): void {
  if (text.trim() === "") throw invalid(`The ${label} is empty.`);
  if (text.includes("\0"))
    throw invalid(`The ${label} holds a null character, which cannot be kept.`);
  if (Array.from(text).length > max)
    throw invalid(`The ${label} is longer than ${String(max)} characters.`);
}

/**
 * The element with an id. A metric may be named by key or alias, a term by
 * name or alias, a category by path; only the id is looked up, and whether
 * the caller may see the element is decided after, as for an id.
 */
export async function resolveElement(
  context: ServiceContext,
  element: ThreadElement,
): Promise<ThreadElement> {
  const { kind, id } = element;
  if (looksLikeId(id)) return element;
  const { db } = context;
  switch (kind) {
    case "metric": {
      const allowed = await context.access.describableDatasets(
        context.principal,
      );
      const hides = !(await readsPii(context));
      return { kind, id: (await resolveMetric(db, allowed, hides, id)).id };
    }
    case "term":
      return { kind, id: (await resolveTerm(db, id)).id };
    case "category":
      return { kind, id: (await loadTree(db)).get(id).id };
    default:
      return element;
  }
}

export async function describes(
  context: ServiceContext,
  element: ThreadElement,
): Promise<boolean> {
  const { db, principal } = context;
  const allowed = await context.access.describableDatasets(principal);
  const hides = !(await readsPii(context));
  const { rows } = looksLikeId(element.id)
    ? await db.execute(
        sql`select 1 where ${elementSeen(db, allowed, { kind: sql`${element.kind}::text`, id: sql`${element.id}::uuid` }, true, hides)}`,
      )
    : { rows: [] };
  return rows.length > 0;
}

export type NewThread = {
  kind: ThreadKind;
  element: ThreadElement;
  /** A question's, and only a question has one. */
  title?: string | null;
  body: string;
};

export async function postThread(context: ServiceContext, input: NewThread) {
  await requireQuestions(context);
  const { principal, db } = context;
  const title = input.title?.trim() || null;
  if (input.kind === "question" && title === null)
    throw invalid("A question needs a title.");
  if (input.kind === "comment" && title !== null)
    throw invalid("A comment has no title.");
  if (title !== null) checkedText("title", title, THREAD_TITLE_MAX);
  checkedText("body", input.body, THREAD_BODY_MAX);
  const element = await resolveElement(context, input.element);
  if (!(await describes(context, element)))
    throw new ServiceError(
      "not_found",
      element.kind === "dataset" ? NO_SUCH_DATASET : `No such ${element.kind}.`,
    );
  const id = randomUUID();
  await context.access.require(
    principal,
    resourceOf({
      id,
      kind: input.kind,
      status: "open",
      ...authorOf(principal),
    }),
    "create",
  );
  const now = context.clock();
  const created = {
    id,
    kind: input.kind,
    element_kind: element.kind,
    element_id: element.id,
    title,
    body: input.body,
    ...authorOf(principal),
    status: "open" as const,
    accepted_reply_id: null,
    accepted_by_role: null,
    accepted_by_kind: null,
    accepted_by_via: null,
    created_at: now,
    updated_at: now,
  };
  await withEvents(db, async (tx, emit) => {
    await tx.insert(thread).values(created);
    emit({
      kind: "thread.created",
      element_kind: "thread",
      element_id: id,
      principal,
      data: { thread_kind: input.kind, element },
    });
  });
  return shape({
    ...created,
    reply_count: 0,
    unread_replies: 0,
    upvote_count: 0,
    upvoted: false,
  });
}

/**
 * Finds the thread as the caller sees it and locks it, asks Cerbos whether
 * the caller may do `action` to it, then lets `work` change it, so what
 * `work` checks about the thread holds until the transaction commits.
 */
async function amend<T>(
  context: ServiceContext,
  id: string,
  action: "reply" | "upvote" | "accept" | "archive",
  work: (tx: Db, row: Anchor, emit: Emit) => Promise<T>,
): Promise<T> {
  const { principal } = context;
  const allowed = await context.access.describableDatasets(principal);
  const hides = !(await readsPii(context));
  return withEvents(context.db, async (tx, emit) => {
    const row = await findThread(tx, principal, allowed, hides, id, true);
    await context.access.require(principal, resourceOf(row), action);
    return work(tx, row, emit);
  });
}

/** An archived thread is kept as it was: it takes no reply, upvote or accepted answer. */
function refuseArchived(row: Anchor): void {
  if (row.status === "archived")
    throw new ServiceError(
      "conflict",
      "This thread is archived. It takes no more replies, upvotes or answers.",
    );
}

const aboutThread = (row: Anchor) => ({
  thread_kind: row.kind,
  element: { kind: row.element_kind, id: row.element_id },
});

const replyOf = (row: typeof threadReply.$inferSelect) => ({
  id: row.id,
  thread_id: row.thread_id,
  author: { kind: row.author_kind, id: row.author_id },
  body: row.body,
  created_at: row.created_at,
  edited_at: row.edited_at,
});

export async function reply(
  context: ServiceContext,
  threadId: string,
  body: string,
) {
  await requireQuestions(context);
  checkedText("reply", body, THREAD_BODY_MAX);
  const { principal } = context;
  const now = context.clock();
  return amend(context, threadId, "reply", async (tx, row, emit) => {
    refuseArchived(row);
    const [created] = await tx
      .insert(threadReply)
      .values({
        thread_id: row.id,
        ...authorOf(principal),
        body,
        created_at: now,
      })
      .returning();
    if (created === undefined) throw new Error("The reply was not stored.");
    await tx
      .update(thread)
      .set({ updated_at: now })
      .where(eq(thread.id, row.id));
    emit({
      kind: "thread.replied",
      element_kind: "thread",
      element_id: row.id,
      principal,
      data: { ...aboutThread(row), reply_id: created.id },
    });
    return replyOf(created);
  });
}

/** The thread with its replies, the accepted one marked. Reading it marks it viewed. */
export async function getThread(context: ServiceContext, id: string) {
  await requireQuestions(context);
  const { principal, db } = context;
  const now = context.clock();
  const allowed = await context.access.describableDatasets(principal);
  const hides = !(await readsPii(context));
  // Counted before this view, so unread_replies says what is new to the caller.
  const row = await findThread(db, principal, allowed, hides, id);
  const replies = await db
    .select()
    .from(threadReply)
    .where(eq(threadReply.thread_id, row.id))
    .orderBy(asc(threadReply.created_at), asc(threadReply.id));
  await db
    .insert(threadView)
    .values({ thread_id: row.id, ...principalOf(principal), viewed_at: now })
    .onConflictDoUpdate({
      target: [
        threadView.thread_id,
        threadView.principal_kind,
        threadView.principal_id,
      ],
      set: { viewed_at: now },
    });
  return {
    ...shape(row),
    replies: replies.map((one) => ({
      ...replyOf(one),
      accepted: one.id === row.accepted_reply_id,
    })),
  };
}

export type ThreadFilters = {
  element?: ThreadElement;
  kind?: ThreadKind;
  /** Archived threads are left out unless this says `archived`. */
  status?: ThreadStatus;
  /** Only the threads this caller started. */
  mine?: boolean;
  /** Words in the title or body. */
  text?: string;
  /** `cursor` is the `next_cursor` of the page before. */
  cursor?: string;
  limit?: number;
};

/** Newest first, so a list is ordered by the thread's time and id, and its cursor holds both. */
const newestFirst = { descending: true, name: z.iso.datetime() };

export async function listThreads(
  context: ServiceContext,
  filters: ThreadFilters = {},
) {
  await requireQuestions(context);
  const { principal, db } = context;
  const element =
    filters.element === undefined
      ? undefined
      : await resolveElement(context, filters.element);
  if (element !== undefined && !looksLikeId(element.id))
    return { items: [], next_cursor: null };
  const allowed = await context.access.describableDatasets(principal);
  const hides = !(await readsPii(context));
  const limit = sizeOf(filters.limit);
  const rows = await db
    .select({
      ...anchorColumns(principal),
      excerpt: sql<string>`left(${thread.body}, ${EXCERPT + 1})`,
    })
    .from(thread)
    .where(
      and(
        threadsSeen(db, allowed, hides),
        element === undefined
          ? undefined
          : and(
              eq(thread.element_kind, element.kind),
              eq(thread.element_id, element.id),
            ),
        filters.kind === undefined ? undefined : eq(thread.kind, filters.kind),
        filters.status === undefined
          ? ne(thread.status, "archived")
          : eq(thread.status, filters.status),
        filters.mine === true
          ? and(
              eq(thread.author_kind, principal.kind),
              eq(thread.author_id, principal.id),
            )
          : undefined,
        filters.text === undefined
          ? undefined
          : sql`${thread.search_tsv} @@ websearch_to_tsquery('simple', ${filters.text})`,
        afterCursor(
          { name: thread.created_at, id: thread.id },
          filters.cursor,
          newestFirst,
        ),
      ),
    )
    .orderBy(desc(thread.created_at), desc(thread.id))
    .limit(limit + 1);
  const page = pageBy(rows, limit, (row) => row.created_at.toISOString());
  // A term's or a category's thread belongs to no dataset, so anyone signed in
  // reads it. Who asked is shown only to a caller who can see a dataset, one
  // the sync saw go included, as threadsSeen counts it.
  const [sees] = await db
    .select({ one: sql`1` })
    .from(powerbiDataset)
    .where(allowed)
    .limit(1);
  const names =
    sees === undefined
      ? new Map<string, string>()
      : await namesOf(
          db,
          page.items.map(({ author_kind: kind, author_id: id }) => ({
            kind,
            id,
          })),
          "name",
        );
  return {
    items: page.items.map((row) => {
      const cut = excerpt(row.excerpt, EXCERPT);
      return {
        ...shape(row),
        excerpt: cut.text,
        ...(cut.truncated && { excerpt_truncated: true as const }),
        author_name:
          sees === undefined
            ? null
            : (names.get(
                whoKey({ kind: row.author_kind, id: row.author_id }),
              ) ?? REMOVED_PERSON),
      };
    }),
    next_cursor: page.next_cursor,
  };
}

/** The asker or a curator accepts one reply of a question as its answer. */
export async function acceptReply(
  context: ServiceContext,
  threadId: string,
  replyId: string,
) {
  await requireQuestions(context);
  const { principal } = context;
  const now = context.clock();
  return amend(context, threadId, "accept", async (tx, row, emit) => {
    if (row.kind !== "question")
      throw invalid("Only a question takes an accepted answer.");
    refuseArchived(row);
    const [chosen] = looksLikeId(replyId)
      ? await tx
          .select({
            id: threadReply.id,
            author_kind: threadReply.author_kind,
            author_id: threadReply.author_id,
          })
          .from(threadReply)
          .where(
            and(eq(threadReply.id, replyId), eq(threadReply.thread_id, row.id)),
          )
      : [];
    if (chosen === undefined)
      throw new ServiceError("not_found", "No such reply in this thread.");
    const isAsker =
      row.author_kind === principal.kind && row.author_id === principal.id;
    const role = isAsker
      ? chosen.author_kind === principal.kind &&
        chosen.author_id === principal.id
        ? ("asker_own_reply" as const)
        : ("asker" as const)
      : principal.roles.includes("curator")
        ? ("curator" as const)
        : ("other" as const);
    const who = {
      accepted_by_role: role,
      accepted_by_kind: principal.kind,
      accepted_by_via: principal.via,
    };
    if (row.accepted_reply_id === chosen.id) {
      // A curator's acceptance of what the asker or an unrecorded acceptor chose records the curator.
      const upgrades =
        role === "curator" &&
        (row.accepted_by_role === null || row.accepted_by_role === "asker");
      if (!upgrades) return shape(row);
      await tx.update(thread).set(who).where(eq(thread.id, row.id));
      return shape({ ...row, ...who });
    }
    const accepted = {
      status: "answered" as const,
      accepted_reply_id: chosen.id,
      ...who,
      updated_at: now,
    };
    await tx.update(thread).set(accepted).where(eq(thread.id, row.id));
    emit({
      kind: "thread.answered",
      element_kind: "thread",
      element_id: row.id,
      principal,
      data: { ...aboutThread(row), reply_id: chosen.id },
    });
    return shape({ ...row, ...accepted });
  });
}

/** A curator archives a thread: it leaves the default lists and search, and is kept. */
export async function archiveThread(context: ServiceContext, id: string) {
  await requireQuestions(context);
  const { principal } = context;
  const now = context.clock();
  return amend(context, id, "archive", async (tx, row, emit) => {
    if (row.status === "archived") return shape(row);
    const archived = { status: "archived" as const, updated_at: now };
    await tx.update(thread).set(archived).where(eq(thread.id, row.id));
    emit({
      kind: "thread.archived",
      element_kind: "thread",
      element_id: row.id,
      principal,
      data: aboutThread(row),
    });
    return shape({ ...row, ...archived });
  });
}

/** One upvote per principal on a question; putting it again, or taking back one never given, changes nothing. */
export async function setUpvote(
  context: ServiceContext,
  threadId: string,
  upvoted: boolean,
) {
  await requireQuestions(context);
  const { principal } = context;
  return amend(context, threadId, "upvote", async (tx, row) => {
    if (row.kind !== "question")
      throw invalid("Only a question takes upvotes.");
    refuseArchived(row);
    const mine = { thread_id: row.id, ...principalOf(principal) };
    // The thread is locked, so what its row says of this principal's upvote is what the table holds.
    if (upvoted && !row.upvoted) {
      await tx
        .insert(threadUpvote)
        .values({ ...mine, created_at: context.clock() });
    } else if (!upvoted && row.upvoted) {
      await tx
        .delete(threadUpvote)
        .where(
          and(
            eq(threadUpvote.thread_id, mine.thread_id),
            eq(threadUpvote.principal_kind, mine.principal_kind),
            eq(threadUpvote.principal_id, mine.principal_id),
          ),
        );
    }
    return {
      thread_id: row.id,
      upvoted,
      upvote_count: row.upvote_count + Number(upvoted) - Number(row.upvoted),
    };
  });
}
