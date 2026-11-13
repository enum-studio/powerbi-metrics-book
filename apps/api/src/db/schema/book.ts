import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { iconCheck } from "../../services/book/icon-glyphs.js";
import { declareGrants, type Privilege } from "../grants.js";
import { powerbiColumn, powerbiMeasure } from "./mirror.js";

/*
 * The metrics book: the company's conventions, its categories, metrics,
 * variants and terms, and the record of every change to them. Each closed set
 * is a CHECK; book.test.ts fails when its list and the constant beside it
 * differ. Not closed here, because the conventions own them and the service
 * validates: a metric's unit and name form, a variant's period and
 * comparison_period, currency and custom axes.
 */

export const TRUST_STATES = [
  "draft",
  "agent_verified",
  "human_verified",
] as const;
export const ORIGINS = ["sync", "curator"] as const;
export const COMPARISONS = [
  "none",
  "difference",
  "growth_rate",
  "ratio",
] as const;
export const ASSIGNED_BY = ["sync", "curator"] as const;
/** Principal's two kinds, and the sync, which has no principal. */
export const CHANGE_PRINCIPAL_KINDS = [
  "person",
  "service_account",
  "system",
] as const;
/** Principal's `via`; a change by the sync came through none. */
export const VIAS = ["browser", "mcp", "api", "cli"] as const;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const createdAndUpdated = () => ({
  created_at: timestamptz("created_at").notNull().defaultNow(),
  updated_at: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

const customColumn = (name = "custom") =>
  jsonb(name).$type<Record<string, unknown>>().notNull().default({});

const isObject = (name: string, column: AnyPgColumn) =>
  check(name, sql`jsonb_typeof(${column}) = 'object'`);

/** One version per change; the newest is in force. */
export const conventions = pgTable(
  "conventions",
  {
    version: integer("version").primaryKey(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    set_by: text("set_by").notNull(),
    set_at: timestamptz("set_at").notNull().defaultNow(),
  },
  (t) => [isObject("conventions_document_check", t.document)],
);

/** A parent's children go before it does: the keys do not cascade, so deleting a category that holds anything is refused. */
export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parent_id: uuid("parent_id").references((): AnyPgColumn => category.id),
    name: text("name").notNull(),
    key: text("key").notNull(),
    description: text("description"),
    icon: text("icon"),
    position: integer("position").notNull().default(0),
    ...createdAndUpdated(),
  },
  (t) => [
    check("category_icon_check", sql.raw(iconCheck("icon"))),
    // A null parent_id is never equal to another, so the root level has its own index.
    unique("category_parent_id_key_key").on(t.parent_id, t.key),
    uniqueIndex("category_root_key_idx")
      .on(t.key)
      .where(sql`${t.parent_id} is null`),
  ],
);

/**
 * The text fields are empty strings until someone writes them; aliases and
 * not_the_same_as are null until reviewed, and an empty array or string then
 * means "none". touched_at is set by a curator's first change: until then the
 * sync may still regroup the draft's measures.
 */
export const metric = pgTable(
  "metric",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique("metric_name_key"),
    label: text("label").notNull(),
    definition: text("definition").notNull().default(""),
    aliases: text("aliases").array(),
    when_to_use: text("when_to_use").notNull().default(""),
    not_the_same_as: text("not_the_same_as"),
    grain_and_filters: text("grain_and_filters").notNull().default(""),
    unit: text("unit"),
    category_id: uuid("category_id").references(() => category.id),
    icon: text("icon"),
    owner: text("owner"),
    trust_state: text("trust_state", { enum: TRUST_STATES })
      .notNull()
      .default("draft"),
    verified_by: text("verified_by"),
    verified_at: timestamptz("verified_at"),
    origin: text("origin", { enum: ORIGINS }).notNull(),
    name_is_generated: boolean("name_is_generated").notNull().default(false),
    touched_at: timestamptz("touched_at"),
    dismissed_at: timestamptz("dismissed_at"),
    dismissed_reason: text("dismissed_reason"),
    custom: customColumn(),
    ...createdAndUpdated(),
  },
  (t) => [
    index("metric_trust_state_idx").on(t.trust_state),
    index("metric_category_id_idx").on(t.category_id),
    check(
      "metric_trust_state_check",
      sql`${t.trust_state} in ('draft', 'agent_verified', 'human_verified')`,
    ),
    check("metric_origin_check", sql`${t.origin} in ('sync', 'curator')`),
    check("metric_icon_check", sql.raw(iconCheck("icon"))),
    isObject("metric_custom_check", t.custom),
  ],
);

/** A variant has no meaning without its metric or its measure, so it goes with either. */
export const metricVariant = pgTable(
  "metric_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metric_id: uuid("metric_id")
      .notNull()
      .references(() => metric.id, { onDelete: "cascade" }),
    measure_id: uuid("measure_id")
      .notNull()
      .unique("metric_variant_measure_id_key")
      .references(() => powerbiMeasure.id, { onDelete: "cascade" }),
    period: text("period").notNull().default("current"),
    comparison: text("comparison", { enum: COMPARISONS })
      .notNull()
      .default("none"),
    comparison_period: text("comparison_period"),
    currency: text("currency"),
    shift_note: text("shift_note"),
    custom_axes: customColumn("custom_axes"),
    reads_selection: boolean("reads_selection").notNull().default(false),
    selection_columns: text("selection_columns").array().notNull().default([]),
    assigned_by: text("assigned_by", { enum: ASSIGNED_BY }).notNull(),
    assigned_at: timestamptz("assigned_at").notNull().defaultNow(),
  },
  (t) => [
    index("metric_variant_metric_id_idx").on(t.metric_id),
    check(
      "metric_variant_comparison_check",
      sql`${t.comparison} in ('none', 'difference', 'growth_rate', 'ratio')`,
    ),
    check(
      "metric_variant_assigned_by_check",
      sql`${t.assigned_by} in ('sync', 'curator')`,
    ),
    isObject("metric_variant_custom_axes_check", t.custom_axes),
  ],
);

/** values is null for a concept term and for a dimension term that is not categorical. */
export const term = pgTable(
  "term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique("term_name_key"),
    definition: text("definition").notNull().default(""),
    aliases: text("aliases").array(),
    not_the_same_as: text("not_the_same_as"),
    values: jsonb("values").$type<unknown>(),
    icon: text("icon"),
    owner: text("owner"),
    trust_state: text("trust_state", { enum: TRUST_STATES })
      .notNull()
      .default("draft"),
    custom: customColumn(),
    ...createdAndUpdated(),
  },
  (t) => [
    check(
      "term_trust_state_check",
      sql`${t.trust_state} in ('draft', 'agent_verified', 'human_verified')`,
    ),
    isObject("term_custom_check", t.custom),
    check("term_icon_check", sql.raw(iconCheck("icon"))),
  ],
);

export const termColumn = pgTable(
  "term_column",
  {
    term_id: uuid("term_id")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    column_id: uuid("column_id")
      .notNull()
      .references(() => powerbiColumn.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.term_id, t.column_id] }),
    index("term_column_column_id_idx").on(t.column_id),
  ],
);

export const termMetric = pgTable(
  "term_metric",
  {
    term_id: uuid("term_id")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    metric_id: uuid("metric_id")
      .notNull()
      .references(() => metric.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.term_id, t.metric_id] }),
    index("term_metric_metric_id_idx").on(t.metric_id),
  ],
);

/**
 * Who changed what, with the element as it was and as it became (null for a
 * creation or a deletion). The id is an identity column, not bigserial: an
 * insert needs no right on a sequence, so the grants below stay the whole
 * story of who may write.
 */
export const bookChange = pgTable(
  "book_change",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    at: timestamptz("at").notNull().defaultNow(),
    principal_kind: text("principal_kind", {
      enum: CHANGE_PRINCIPAL_KINDS,
    }).notNull(),
    principal_id: text("principal_id").notNull(),
    via: text("via", { enum: VIAS }),
    element_kind: text("element_kind").notNull(),
    element_id: text("element_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
  },
  (t) => [
    check(
      "book_change_principal_kind_check",
      sql`${t.principal_kind} in ('person', 'service_account', 'system')`,
    ),
    check(
      "book_change_via_check",
      sql`${t.via} in ('browser', 'mcp', 'api', 'cli')`,
    ),
  ],
);

const ALL: readonly Privilege[] = ["select", "insert", "update", "delete"];
const INSERT_ONLY: readonly Privilege[] = ["select", "insert"];
/** Curation of categories and terms is the api's alone. The worker only reads them, to build the search documents it embeds. */
const curatedByApi = {
  api_rw: ALL,
  worker_rw: ["select"],
  audit_writer: [],
} as const;
/** The drafter creates, regroups and deletes metrics and their variants, so both containers hold every right on them. */
const both = { api_rw: ALL, worker_rw: ALL, audit_writer: [] } as const;

declareGrants({
  // The worker reads the conventions to draft by them and never changes them.
  conventions: { api_rw: ALL, worker_rw: ["select"], audit_writer: [] },
  category: curatedByApi,
  metric: both,
  metric_variant: both,
  term: curatedByApi,
  term_column: curatedByApi,
  term_metric: curatedByApi,
  // The audit rule: no role that writes a record can rewrite or remove it.
  book_change: {
    api_rw: INSERT_ONLY,
    worker_rw: INSERT_ONLY,
    audit_writer: [],
  },
});
