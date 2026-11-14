import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { QueryColumn } from "../../powerbi/execute.js";
import { declareGrants } from "../grants.js";
import { VIAS } from "./book.js";

/*
 * Results of DAX queries, kept in pages until they expire, and the query log,
 * one row per query whatever its outcome. A result holds rows read under its
 * owner's row-level security; the store answers only its owner.
 */

export const QUERY_STATUSES = [
  "succeeded",
  "truncated",
  "failed",
  "refused",
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];
export const PRINCIPAL_KINDS = ["person", "service_account"] as const;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
/** Written by the trigger in src/db/sql/queries.sql, never by the api. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const queryResult = pgTable(
  "query_result",
  {
    id: uuid("id").primaryKey(),
    // The query_log row is written after the result, so neither references the other.
    query_id: uuid("query_id").notNull(),
    owner_kind: text("owner_kind", { enum: PRINCIPAL_KINDS }).notNull(),
    owner_id: text("owner_id").notNull(),
    dataset_id: uuid("dataset_id").notNull(),
    columns: jsonb("columns").$type<QueryColumn[]>().notNull(),
    row_count: integer("row_count").notNull(),
    truncated: boolean("truncated").notNull(),
    truncation_note: text("truncation_note"),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    page_rows: integer("page_rows").notNull(),
    created_at: timestamptz("created_at").notNull().defaultNow(),
    expires_at: timestamptz("expires_at").notNull(),
  },
  (t) => [
    index("query_result_expires_at_idx").on(t.expires_at),
    check(
      "query_result_owner_kind_check",
      sql`${t.owner_kind} in ('person', 'service_account')`,
    ),
    check(
      "query_result_truncation_note_check",
      sql`${t.truncated} = (${t.truncation_note} is not null)`,
    ),
  ],
);

export const queryResultPage = pgTable(
  "query_result_page",
  {
    result_id: uuid("result_id")
      .notNull()
      .references(() => queryResult.id, { onDelete: "cascade" }),
    page_number: integer("page_number").notNull(),
    rows: jsonb("rows").$type<unknown[][]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.result_id, t.page_number] })],
);

export const queryLog = pgTable(
  "query_log",
  {
    // Given by the query service: audit_writer inserts without returning.
    id: uuid("id").primaryKey(),
    at: timestamptz("at").notNull(),
    principal_kind: text("principal_kind", { enum: PRINCIPAL_KINDS }).notNull(),
    principal_id: text("principal_id").notNull(),
    via: text("via", { enum: VIAS }).notNull(),
    client_id: text("client_id"),
    powerbi_account: text("powerbi_account"),
    // Null when the caller named a dataset they may not describe.
    dataset_id: uuid("dataset_id"),
    // The name when the query ran, which search reads without a join audit_writer could not make.
    dataset_name: text("dataset_name"),
    workspace_id: uuid("workspace_id"),
    dax: text("dax").notNull(),
    dax_hash: text("dax_hash").notNull(),
    purpose: text("purpose"),
    origin: text("origin", { enum: ["request", "catalog"] })
      .notNull()
      .default("request"),
    status: text("status", { enum: QUERY_STATUSES }).notNull(),
    error: text("error"),
    row_count: integer("row_count"),
    column_count: integer("column_count"),
    bytes: bigint("bytes", { mode: "number" }),
    duration_ms: integer("duration_ms").notNull(),
    result_id: uuid("result_id"),
    // So an expired result still answers when it expired, after the worker deleted it.
    result_expires_at: timestamptz("result_expires_at"),
    measure_names: text("measure_names").array().notNull().default([]),
    metric_ids: uuid("metric_ids").array().notNull().default([]),
    search_tsv: tsvector("search_tsv"),
  },
  (t) => [
    index("query_log_at_idx").on(t.at, t.id),
    index("query_log_principal_idx").on(t.principal_kind, t.principal_id, t.at),
    index("query_log_result_id_idx").on(t.result_id),
    index("query_log_search_tsv_idx").using("gin", t.search_tsv),
    index("query_log_metric_ids_idx").using("gin", t.metric_ids),
    check("query_log_origin_check", sql`${t.origin} in ('request', 'catalog')`),
    check(
      "query_log_status_check",
      sql`${t.status} in ('succeeded', 'truncated', 'failed', 'refused')`,
    ),
    check(
      "query_log_via_check",
      sql`${t.via} in ('browser', 'mcp', 'api', 'cli')`,
    ),
    check(
      "query_log_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
  ],
);

/**
 * Rows held against a principal's daily budget by each query in flight, so
 * parallel queries cannot pass it. A crashed api's reservation lapses at
 * expires_at.
 */
export const queryReservation = pgTable(
  "query_reservation",
  {
    id: uuid("id").primaryKey(),
    principal_kind: text("principal_kind", { enum: PRINCIPAL_KINDS }).notNull(),
    principal_id: text("principal_id").notNull(),
    rows: integer("rows").notNull(),
    expires_at: timestamptz("expires_at").notNull(),
  },
  (t) => [
    index("query_reservation_principal_idx").on(
      t.principal_kind,
      t.principal_id,
    ),
    check(
      "query_reservation_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
  ],
);

declareGrants({
  query_reservation: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  query_result: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: ["select", "delete"],
    audit_writer: [],
  },
  query_result_page: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: ["select", "delete"],
    audit_writer: [],
  },
  query_log: {
    api_rw: ["select"],
    worker_rw: ["select"],
    audit_writer: ["insert"],
  },
});
