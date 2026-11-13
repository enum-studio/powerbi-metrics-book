import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

/*
 * The change feed: one row per thing that happened to the book, written in
 * the transaction of the change it describes. A closed set is a CHECK;
 * book.test.ts fails when its list and the constant beside it differ.
 */

export const EVENT_KINDS = [
  "metric.created",
  "metric.changed",
  "metric.verified",
  "metric.approved",
  "draft.created",
  "variant.moved",
  "term.changed",
  "conventions.changed",
  "thread.created",
  "thread.replied",
  "thread.answered",
  "thread.archived",
  "sync.finished",
  "sync.failed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** An event with no principal (the sync's) has neither column set. */
export const EVENT_PRINCIPAL_KINDS = ["person", "service_account"] as const;

/**
 * The id is an identity column, not bigserial: an insert needs no right on a
 * sequence, so the grants below stay the whole story of who may write.
 */
export const event = pgTable(
  "event",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    element_kind: text("element_kind"),
    element_id: text("element_id"),
    principal_kind: text("principal_kind", { enum: EVENT_PRINCIPAL_KINDS }),
    principal_id: text("principal_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    // Readers page by id, per kind or across all of them; the primary key serves the second.
    index("event_kind_id_idx").on(t.kind, t.id),
    check(
      "event_kind_check",
      sql`${t.kind} in ('metric.created', 'metric.changed', 'metric.verified', 'metric.approved', 'draft.created', 'variant.moved', 'term.changed', 'conventions.changed', 'thread.created', 'thread.replied', 'thread.answered', 'thread.archived', 'sync.finished', 'sync.failed')`,
    ),
    check(
      "event_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
  ],
);

declareGrants({
  event: {
    api_rw: ["select", "insert"],
    // The worker's expire job trims the feed to 90 days; no other role deletes.
    worker_rw: ["select", "insert", "delete"],
    audit_writer: [],
  },
});
