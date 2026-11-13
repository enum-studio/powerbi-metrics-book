import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

/*
 * Questions and comments on any element. Each closed set is a CHECK that
 * lists the constant beside it. A thread's element is one of several tables,
 * so element_id has no foreign key: what a reader may see of it is decided by
 * the thread service. search_tsv is kept by the trigger in sql/threads.sql.
 */

export const THREAD_KINDS = ["question", "comment"] as const;
export const THREAD_STATUSES = ["open", "answered", "archived"] as const;
export const THREAD_ELEMENT_KINDS = [
  "workspace",
  "dataset",
  "table",
  "column",
  "measure",
  "metric",
  "variant",
  "term",
  "category",
  "query",
] as const;
export type ThreadElementKind = (typeof THREAD_ELEMENT_KINDS)[number];
export type ThreadElement = { kind: ThreadElementKind; id: string };
/** Who accepted an answer: the asker, the asker on their own reply, a curator, or anyone else a policy allows. Answers accepted before this was kept read `unknown`. */
export const THREAD_ACCEPTED_BY = [
  "asker",
  "asker_own_reply",
  "curator",
  "other",
] as const;
export const THREAD_ACCEPTED_VIA = ["browser", "mcp", "api", "cli"] as const;
export const THREAD_PRINCIPAL_KINDS = ["person", "service_account"] as const;
/** Bodies are plain text with Markdown; the bound keeps one thread from filling an agent's context. */
export const THREAD_BODY_MAX = 20_000;
export const THREAD_TITLE_MAX = 300;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
/** Milliseconds, as the clock gives them: a list's cursor is a thread's time, and must round-trip exactly. */
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow();

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/**
 * A question has a title and a comment has none. Only a question has an
 * accepted reply; a thread is `answered` only while it has one (an archived
 * thread keeps it). The composite key makes the accepted reply one of this
 * thread's own.
 */
export const thread = pgTable(
  "thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: THREAD_KINDS }).notNull(),
    element_kind: text("element_kind", {
      enum: THREAD_ELEMENT_KINDS,
    }).notNull(),
    element_id: uuid("element_id").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    author_kind: text("author_kind", {
      enum: THREAD_PRINCIPAL_KINDS,
    }).notNull(),
    author_id: text("author_id").notNull(),
    status: text("status", { enum: THREAD_STATUSES }).notNull().default("open"),
    accepted_reply_id: uuid("accepted_reply_id"),
    // Who accepted it and in what standing; null on answers accepted before this was kept.
    accepted_by_role: text("accepted_by_role", { enum: THREAD_ACCEPTED_BY }),
    accepted_by_kind: text("accepted_by_kind", {
      enum: THREAD_PRINCIPAL_KINDS,
    }),
    accepted_by_via: text("accepted_by_via", { enum: THREAD_ACCEPTED_VIA }),
    created_at: createdAt(),
    updated_at: timestamptz("updated_at").notNull().defaultNow(),
    search_tsv: tsvector("search_tsv")
      .notNull()
      .default(sql`''::tsvector`),
  },
  (t) => [
    index("thread_element_idx").on(t.element_kind, t.element_id),
    index("thread_author_idx").on(t.author_kind, t.author_id),
    index("thread_created_at_idx").on(t.created_at.desc(), t.id.desc()),
    index("thread_search_tsv_idx").using("gin", t.search_tsv),
    foreignKey({
      name: "thread_accepted_reply_fkey",
      columns: [t.id, t.accepted_reply_id],
      foreignColumns: [threadReply.thread_id, threadReply.id],
    }),
    check("thread_kind_check", sql`${t.kind} in ('question', 'comment')`),
    check(
      "thread_element_kind_check",
      sql`${t.element_kind} in ('workspace', 'dataset', 'table', 'column', 'measure', 'metric', 'variant', 'term', 'category', 'query')`,
    ),
    check(
      "thread_status_check",
      sql`${t.status} in ('open', 'answered', 'archived')`,
    ),
    check(
      "thread_author_kind_check",
      sql`${t.author_kind} in ('person', 'service_account')`,
    ),
    check(
      "thread_title_check",
      sql`(${t.kind} = 'question' and ${t.title} is not null and char_length(${t.title}) between 1 and 300) or (${t.kind} = 'comment' and ${t.title} is null)`,
    ),
    check("thread_body_check", sql`char_length(${t.body}) between 1 and 20000`),
    check(
      "thread_accepted_by_check",
      sql`(${t.accepted_by_role} is null or ${t.accepted_by_role} in ('asker', 'asker_own_reply', 'curator', 'other')) and (${t.accepted_by_kind} is null or ${t.accepted_by_kind} in ('person', 'service_account')) and (${t.accepted_by_via} is null or ${t.accepted_by_via} in ('browser', 'mcp', 'api', 'cli')) and (${t.accepted_by_role} is null) = (${t.accepted_by_via} is null) and (${t.accepted_by_role} is null) = (${t.accepted_by_kind} is null) and (${t.accepted_by_role} is null or ${t.accepted_reply_id} is not null)`,
    ),
    check(
      "thread_accepted_reply_check",
      sql`(${t.accepted_reply_id} is null or ${t.kind} = 'question') and (${t.status} <> 'answered' or ${t.accepted_reply_id} is not null)`,
    ),
  ],
);

export const threadReply = pgTable(
  "thread_reply",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    thread_id: uuid("thread_id")
      .notNull()
      .references((): AnyPgColumn => thread.id, { onDelete: "cascade" }),
    author_kind: text("author_kind", {
      enum: THREAD_PRINCIPAL_KINDS,
    }).notNull(),
    author_id: text("author_id").notNull(),
    body: text("body").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
    edited_at: timestamptz("edited_at"),
  },
  (t) => [
    unique("thread_reply_thread_id_id_key").on(t.thread_id, t.id),
    index("thread_reply_thread_id_created_at_idx").on(
      t.thread_id,
      t.created_at,
    ),
    check(
      "thread_reply_author_kind_check",
      sql`${t.author_kind} in ('person', 'service_account')`,
    ),
    check(
      "thread_reply_body_check",
      sql`char_length(${t.body}) between 1 and 20000`,
    ),
  ],
);

/**
 * One upvote per principal; the service lets only a question be upvoted. The
 * kind is part of the key: a service account may be named like a person's id.
 */
export const threadUpvote = pgTable(
  "thread_upvote",
  {
    thread_id: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    principal_kind: text("principal_kind", {
      enum: THREAD_PRINCIPAL_KINDS,
    }).notNull(),
    principal_id: text("principal_id").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.thread_id, t.principal_kind, t.principal_id] }),
    check(
      "thread_upvote_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
  ],
);

export const threadView = pgTable(
  "thread_view",
  {
    thread_id: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    principal_kind: text("principal_kind", {
      enum: THREAD_PRINCIPAL_KINDS,
    }).notNull(),
    principal_id: text("principal_id").notNull(),
    viewed_at: timestamptz("viewed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.thread_id, t.principal_kind, t.principal_id] }),
    check(
      "thread_view_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
  ],
);

declareGrants({
  thread: {
    // A thread's words and author are written once; only its progress changes.
    api_rw: [
      "select",
      "insert",
      "update(status, accepted_reply_id, accepted_by_role, accepted_by_kind, accepted_by_via, updated_at)",
    ],
    worker_rw: [],
    audit_writer: [],
  },
  thread_reply: {
    api_rw: ["select", "insert"],
    worker_rw: [],
    audit_writer: [],
  },
  thread_upvote: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  thread_view: {
    api_rw: ["select", "insert", "update(viewed_at)"],
    worker_rw: [],
    audit_writer: [],
  },
});
