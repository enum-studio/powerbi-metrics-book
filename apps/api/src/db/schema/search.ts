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
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { declareGrants, type Privilege } from "../grants.js";

/*
 * What search reads: one row per searchable element, rebuilt from the book and
 * the mirror by the embed job, and the count of what embedding them cost. The
 * documents have no foreign keys: they are derived, and a stale one must never
 * block a delete in the tables it was built from. search_tsv is kept by the
 * trigger in sql/search.sql, which also makes the HNSW index there.
 */

export const SEARCH_KINDS = [
  "metric",
  "variant",
  "column",
  "term",
  "dataset",
  "table",
  "category",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
/** The kinds with a vector; the rest are found by words alone. */
export const EMBEDDED_KINDS = [
  "metric",
  "variant",
  "column",
  "term",
] as const satisfies readonly SearchKind[];
export const EMBEDDING_PROVIDERS = ["openai", "gemini"] as const;
export const EMBEDDING_PURPOSES = ["document", "query"] as const;
/** The width of every vector, the same for both providers. */
export const EMBEDDING_DIMENSIONS = 1536;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
/** Written by the trigger in src/db/sql/search.sql, never by the api. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const uuidArray = (name: string) =>
  uuid(name)
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`);

export const searchDocument = pgTable(
  "search_document",
  {
    /** `<kind>:<element id>`. */
    id: text("id").primaryKey(),
    kind: text("kind", { enum: SEARCH_KINDS }).notNull(),
    element_id: uuid("element_id").notNull(),
    // What the describe filter reads: the datasets the element is in, and their workspaces and apps.
    dataset_ids: uuidArray("dataset_ids"),
    workspace_ids: uuidArray("workspace_ids"),
    app_ids: uuidArray("app_ids"),
    category_id: uuid("category_id"),
    trust_state: text("trust_state"),
    custom: jsonb("custom")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    name: text("name").notNull(),
    label: text("label").notNull(),
    summary: text("summary").notNull().default(""),
    search_text: text("search_text").notNull(),
    search_tsv: tsvector("search_tsv"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embedding_model: text("embedding_model"),
    /** SHA-256 of provider, model and search_text; a different one means the vector is stale. */
    embedding_hash: text("embedding_hash"),
    updated_at: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("search_document_element_id_idx").on(t.element_id),
    index("search_document_search_tsv_idx").using("gin", t.search_tsv),
    check(
      "search_document_kind_check",
      sql`${t.kind} in ('metric', 'variant', 'column', 'term', 'dataset', 'table', 'category')`,
    ),
    check(
      "search_document_custom_check",
      sql`jsonb_typeof(${t.custom}) = 'object'`,
    ),
  ],
);

/** One row per provider call, so spend can be added up. Appended, never changed. */
export const embeddingUsage = pgTable(
  "embedding_usage",
  {
    at: timestamptz("at").notNull().defaultNow(),
    provider: text("provider", { enum: EMBEDDING_PROVIDERS }).notNull(),
    model: text("model").notNull(),
    tokens: integer("tokens").notNull(),
    /** Integer micro-dollars: a millionth of a dollar. */
    cost_micro_usd: bigint("cost_micro_usd", { mode: "number" }).notNull(),
    purpose: text("purpose", { enum: EMBEDDING_PURPOSES }).notNull(),
  },
  (t) => [
    index("embedding_usage_at_idx").on(t.at),
    check(
      "embedding_usage_provider_check",
      sql`${t.provider} in ('openai', 'gemini')`,
    ),
    check(
      "embedding_usage_purpose_check",
      sql`${t.purpose} in ('document', 'query')`,
    ),
    check("embedding_usage_tokens_check", sql`${t.tokens} >= 0`),
    check("embedding_usage_cost_check", sql`${t.cost_micro_usd} >= 0`),
  ],
);

/** One row: the highest book_change id and `at` the embed job has applied; the `at` is null until a change exists. */
export const searchState = pgTable(
  "search_state",
  {
    id: boolean("id").primaryKey().default(true),
    book_change_id: bigint("book_change_id", { mode: "number" }).notNull(),
    book_change_at: timestamptz("book_change_at"),
  },
  (t) => [check("search_state_one_row_check", sql`${t.id}`)],
);

const ALL: readonly Privilege[] = ["select", "insert", "update", "delete"];

declareGrants({
  // The worker builds the documents; the api only reads them to search.
  search_document: { api_rw: ["select"], worker_rw: ALL, audit_writer: [] },
  // The worker's alone: only its embed job moves the cursor.
  search_state: {
    api_rw: [],
    worker_rw: ["select", "insert", "update"],
    audit_writer: [],
  },
  // The record of money spent is appended to and never changed. The api embeds
  // each query, so it records that call too.
  embedding_usage: {
    api_rw: ["select", "insert"],
    worker_rw: ["select", "insert"],
    audit_writer: [],
  },
});
