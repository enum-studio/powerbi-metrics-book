import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { escapeLiteral } from "pg";
import { declareGrants } from "../grants.js";
import { VIAS } from "./book.js";
import { PRINCIPAL_KINDS } from "./queries.js";

export const GAP_KINDS = [
  "no_metric",
  "unclear_metric",
  "wrong_definition",
  "missing_description",
  "missing_dimension",
  "no_access",
  "data_wrong",
  "other",
] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export const REQUEST_OUTCOMES = [
  "answered",
  "partly_answered",
  "not_answered",
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
export const SEARCH_LOG_VIAS = ["mcp", "cli", "api"] as const;
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const searchLog = pgTable(
  "search_log",
  {
    id: uuid("id").primaryKey(),
    at: timestamptz("at").notNull(),
    principal_kind: text("principal_kind", { enum: PRINCIPAL_KINDS }).notNull(),
    principal_id: text("principal_id").notNull(),
    via: text("via", { enum: SEARCH_LOG_VIAS }).notNull(),
    client_id: text("client_id"),
    query: text("query").notNull(),
    filters: jsonb("filters").notNull().default({}),
    search_mode: text("search_mode", {
      enum: ["hybrid", "words_only"],
    }).notNull(),
    hit_count: integer("hit_count").notNull(),
    metric_hit: boolean("metric_hit").notNull(),
    top_hits: jsonb("top_hits").notNull().default([]),
  },
  (t) => [
    index("search_log_principal_idx").on(
      t.principal_kind,
      t.principal_id,
      t.at,
    ),
    index("search_log_at_idx").on(t.at),
    check(
      "search_log_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
    check("search_log_via_check", sql`${t.via} in ('mcp', 'cli', 'api')`),
    check(
      "search_log_search_mode_check",
      sql`${t.search_mode} in ('hybrid', 'words_only')`,
    ),
    check("search_log_query_check", sql`char_length(${t.query}) <= 500`),
    check("search_log_hit_count_check", sql`${t.hit_count} >= 0`),
    check(
      "search_log_top_hits_check",
      sql`jsonb_array_length(${t.top_hits}) <= 10`,
    ),
    check(
      "search_log_filters_check",
      sql`jsonb_typeof(${t.filters}) = 'object'`,
    ),
  ],
);

export const request = pgTable(
  "request",
  {
    id: uuid("id").primaryKey(),
    at: timestamptz("at").notNull(),
    principal_kind: text("principal_kind", { enum: PRINCIPAL_KINDS }).notNull(),
    principal_id: text("principal_id").notNull(),
    via: text("via", { enum: VIAS }).notNull(),
    client_id: text("client_id"),
    question: text("question").notNull(),
    outcome: text("outcome", { enum: REQUEST_OUTCOMES }).notNull(),
    gaps: text("gaps", { enum: GAP_KINDS }).array().notNull().default([]),
    missing: text("missing"),
    elements: jsonb("elements").notNull().default([]),
    query_ids: uuid("query_ids").array().notNull().default([]),
    search_ids: uuid("search_ids").array().notNull().default([]),
    /** Written by the trigger in src/db/sql/usage.sql, never by the api. */
    search_tsv: tsvector("search_tsv"),
  },
  (t) => [
    index("request_principal_idx").on(t.principal_kind, t.principal_id, t.at),
    index("request_at_idx").on(t.at),
    index("request_gaps_idx").using("gin", t.gaps),
    index("request_search_tsv_idx").using("gin", t.search_tsv),
    check(
      "request_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account')`,
    ),
    check(
      "request_via_check",
      sql`${t.via} in ('browser', 'mcp', 'api', 'cli')`,
    ),
    check(
      "request_outcome_check",
      sql`${t.outcome} in ('answered', 'partly_answered', 'not_answered')`,
    ),
    check(
      "request_outcome_gaps_check",
      sql`${t.outcome} = 'answered' or cardinality(${t.gaps}) > 0`,
    ),
    check(
      "request_question_check",
      sql`char_length(${t.question}) between 1 and 2000`,
    ),
    check(
      "request_missing_check",
      sql`${t.missing} is null or char_length(${t.missing}) <= 2000`,
    ),
    check(
      "request_gaps_check",
      sql`${t.gaps} <@ array['no_metric', 'unclear_metric', 'wrong_definition', 'missing_description', 'missing_dimension', 'no_access', 'data_wrong', 'other']::text[]`,
    ),
    check(
      "request_gaps_unique_check",
      sql.join(
        GAP_KINDS.map(
          (gap) =>
            sql`cardinality(array_positions(${t.gaps}, ${sql.raw(escapeLiteral(gap))})) <= 1`,
        ),
        sql` and `,
      ),
    ),
    check("request_query_ids_check", sql`cardinality(${t.query_ids}) <= 20`),
    check("request_search_ids_check", sql`cardinality(${t.search_ids}) <= 20`),
    check(
      "request_elements_check",
      sql`jsonb_array_length(${t.elements}) <= 20`,
    ),
  ],
);

declareGrants({
  search_log: {
    api_rw: ["select", "delete"],
    worker_rw: ["select", "delete"],
    audit_writer: ["insert"],
  },
  request: {
    api_rw: ["select", "delete"],
    worker_rw: ["select", "delete"],
    audit_writer: ["insert"],
  },
});
