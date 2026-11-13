import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  uuid,
} from "drizzle-orm/pg-core";
import { iconCheck } from "../../services/book/icon-glyphs.js";
import { declareGrants, type Privilege } from "../grants.js";

/*
 * The mirror of what the Power BI scan sees, and who may reach it. Rows are
 * soft-deleted with removed_at. Every Power BI enumeration stored here is
 * lower snake_case, mapped by the sync. A closed set is a CHECK; mirror.test.ts
 * fails when its list and the constant beside it differ.
 */

export const RELATIONSHIPS_SOURCES = [
  "scanner",
  "info_view",
  "unavailable",
] as const;
export const COLUMN_TYPES = [
  "data",
  "calculated",
  "calculated_table_column",
  "row_number",
] as const;
export const ACCESS_OBJECT_KINDS = ["workspace", "app", "dataset"] as const;
export const PRINCIPAL_TYPES = ["user", "group", "app"] as const;
export const SYNC_KINDS = ["incremental", "full"] as const;
export const SYNC_TRIGGERS = ["schedule", "manual", "deploy"] as const;
export const SYNC_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** What every mirror table adds: when the sync saw it and lost it, then our own fields, which only api_rw writes. */
const mirrorColumns = () => ({
  synced_at: timestamptz("synced_at").notNull().defaultNow(),
  removed_at: timestamptz("removed_at"),
  description: text("description"),
  described_by: text("described_by"),
  described_at: timestamptz("described_at"),
  custom: jsonb("custom")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});

const customIsObject = (table: string, custom: AnyPgColumn) =>
  check(`${table}_custom_check`, sql`jsonb_typeof(${custom}) = 'object'`);

/** A key to a parent row, which takes its children with it when it goes. */
const parent = (name: string, target: () => AnyPgColumn) =>
  uuid(name).notNull().references(target, { onDelete: "cascade" });

export const powerbiWorkspace = pgTable(
  "powerbi_workspace",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type"),
    state: text("state"),
    is_on_dedicated_capacity: boolean("is_on_dedicated_capacity")
      .notNull()
      .default(false),
    first_seen_at: timestamptz("first_seen_at").notNull().defaultNow(),
    /** Ours, like the description: the sync never writes it. */
    icon: text("icon"),
    ...mirrorColumns(),
  },
  (t) => [
    customIsObject("powerbi_workspace", t.custom),
    check("powerbi_workspace_icon_check", sql.raw(iconCheck("icon"))),
  ],
);

export const powerbiApp = pgTable(
  "powerbi_app",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description_pbi: text("description_pbi"),
    workspace_id: parent("workspace_id", () => powerbiWorkspace.id),
    published_by: text("published_by"),
    last_update: timestamptz("last_update"),
    ...mirrorColumns(),
  },
  (t) => [
    index("powerbi_app_workspace_id_idx").on(t.workspace_id),
    customIsObject("powerbi_app", t.custom),
  ],
);

export const powerbiDataset = pgTable(
  "powerbi_dataset",
  {
    id: uuid("id").primaryKey(),
    workspace_id: parent("workspace_id", () => powerbiWorkspace.id),
    name: text("name").notNull(),
    description_pbi: text("description_pbi"),
    configured_by: text("configured_by"),
    target_storage_mode: text("target_storage_mode"),
    has_row_level_security: boolean("has_row_level_security")
      .notNull()
      .default(false),
    endorsement: text("endorsement"),
    sensitivity_label: text("sensitivity_label"),
    schema_error: text("schema_error"),
    relationships_source: text("relationships_source", {
      enum: RELATIONSHIPS_SOURCES,
    }),
    relationships_read_at: timestamptz("relationships_read_at"),
    schema_changed_at: timestamptz("schema_changed_at"),
    /** Off hides the dataset from everyone. New datasets start as powerbi.datasets.new says. */
    enabled: boolean("enabled").notNull().default(true),
    created_date: timestamptz("created_date"),
    /** Ours, like the description: the sync never writes it. */
    icon: text("icon"),
    ...mirrorColumns(),
  },
  (t) => [
    index("powerbi_dataset_workspace_id_idx").on(t.workspace_id),
    check("powerbi_dataset_icon_check", sql.raw(iconCheck("icon"))),
    check(
      "powerbi_dataset_relationships_source_check",
      sql`${t.relationships_source} in ('scanner', 'info_view', 'unavailable')`,
    ),
    customIsObject("powerbi_dataset", t.custom),
  ],
);

export const powerbiAppDataset = pgTable(
  "powerbi_app_dataset",
  {
    app_id: parent("app_id", () => powerbiApp.id),
    dataset_id: parent("dataset_id", () => powerbiDataset.id),
  },
  (t) => [
    primaryKey({ columns: [t.app_id, t.dataset_id] }),
    index("powerbi_app_dataset_dataset_id_idx").on(t.dataset_id),
  ],
);

export const powerbiTable = pgTable(
  "powerbi_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataset_id: parent("dataset_id", () => powerbiDataset.id),
    name: text("name").notNull(),
    is_hidden: boolean("is_hidden").notNull().default(false),
    description_pbi: text("description_pbi"),
    ...mirrorColumns(),
  },
  (t) => [
    unique("powerbi_table_dataset_id_name_key").on(t.dataset_id, t.name),
    index("powerbi_table_dataset_id_removed_at_idx").on(
      t.dataset_id,
      t.removed_at,
    ),
    customIsObject("powerbi_table", t.custom),
  ],
);

export const powerbiColumn = pgTable(
  "powerbi_column",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataset_id: parent("dataset_id", () => powerbiDataset.id),
    table_id: parent("table_id", () => powerbiTable.id),
    name: text("name").notNull(),
    data_type: text("data_type"),
    column_type: text("column_type", { enum: COLUMN_TYPES }),
    expression: text("expression"),
    is_hidden: boolean("is_hidden").notNull().default(false),
    format_string: text("format_string"),
    description_pbi: text("description_pbi"),
    display_folder: text("display_folder"),
    ...mirrorColumns(),
  },
  (t) => [
    unique("powerbi_column_table_id_name_key").on(t.table_id, t.name),
    index("powerbi_column_dataset_id_removed_at_idx").on(
      t.dataset_id,
      t.removed_at,
    ),
    check(
      "powerbi_column_column_type_check",
      sql`${t.column_type} in ('data', 'calculated', 'calculated_table_column', 'row_number')`,
    ),
    customIsObject("powerbi_column", t.custom),
  ],
);

export const powerbiMeasure = pgTable(
  "powerbi_measure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataset_id: parent("dataset_id", () => powerbiDataset.id),
    table_id: parent("table_id", () => powerbiTable.id),
    name: text("name").notNull(),
    expression: text("expression"),
    normalized_expression: text("normalized_expression"),
    fingerprint: text("fingerprint"),
    fingerprint_error: text("fingerprint_error"),
    format_string: text("format_string"),
    display_folder: text("display_folder"),
    is_hidden: boolean("is_hidden").notNull().default(false),
    description_pbi: text("description_pbi"),
    expression_changed_at: timestamptz("expression_changed_at"),
    ...mirrorColumns(),
  },
  (t) => [
    unique("powerbi_measure_dataset_id_name_key").on(t.dataset_id, t.name),
    index("powerbi_measure_dataset_id_removed_at_idx").on(
      t.dataset_id,
      t.removed_at,
    ),
    index("powerbi_measure_table_id_idx").on(t.table_id),
    customIsObject("powerbi_measure", t.custom),
  ],
);

/** The ends are named, not keyed: Power BI's relationship lists give table and column names. */
export const powerbiRelationship = pgTable(
  "powerbi_relationship",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataset_id: parent("dataset_id", () => powerbiDataset.id),
    from_table: text("from_table").notNull(),
    from_column: text("from_column").notNull(),
    to_table: text("to_table").notNull(),
    to_column: text("to_column").notNull(),
    cardinality: text("cardinality"),
    cross_filtering_behavior: text("cross_filtering_behavior"),
    is_active: boolean("is_active").notNull().default(true),
    ...mirrorColumns(),
  },
  (t) => [
    index("powerbi_relationship_dataset_id_removed_at_idx").on(
      t.dataset_id,
      t.removed_at,
    ),
    customIsObject("powerbi_relationship", t.custom),
  ],
);

/** The object is a workspace, an app or a dataset, in three tables, so object_id carries no foreign key. */
export const powerbiAccess = pgTable(
  "powerbi_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    object_kind: text("object_kind", { enum: ACCESS_OBJECT_KINDS }).notNull(),
    object_id: uuid("object_id").notNull(),
    principal_type: text("principal_type", { enum: PRINCIPAL_TYPES }).notNull(),
    principal_object_id: uuid("principal_object_id").notNull(),
    email: text("email"),
    access_right: text("access_right"),
    synced_at: timestamptz("synced_at").notNull().defaultNow(),
  },
  (t) => [
    unique("powerbi_access_object_principal_key").on(
      t.object_kind,
      t.object_id,
      t.principal_type,
      t.principal_object_id,
    ),
    // Kept: visibility looks a person's principals up on every request.
    index("powerbi_access_principal_idx").on(
      t.principal_type,
      t.principal_object_id,
    ),
    check(
      "powerbi_access_object_kind_check",
      sql`${t.object_kind} in ('workspace', 'app', 'dataset')`,
    ),
    check(
      "powerbi_access_principal_type_check",
      sql`${t.principal_type} in ('user', 'group', 'app')`,
    ),
  ],
);

/**
 * A person's read of a dataset's INFO views while it runs, so a request on
 * any api replica that overlaps it waits for it instead of answering that
 * relationships are unknown. The reader adds its row in the transaction
 * that counts the read and deletes it when the read ends; a row left by a
 * process that died is replaced by that person's next read. started_at is
 * Postgres's clock, the one every replica shares. user_id is a
 * Better Auth user id, with no foreign key as in person_identity.
 */
export const modelViewRead = pgTable(
  "model_view_read",
  {
    user_id: text("user_id").notNull(),
    dataset_id: uuid("dataset_id")
      .notNull()
      .references(() => powerbiDataset.id, { onDelete: "cascade" }),
    // Milliseconds, as a JavaScript Date holds them, so the reader's delete matches the stamp it got back.
    started_at: timestamp("started_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.dataset_id] })],
);

/** user_id is a Better Auth user id; that table is another module's, so there is no foreign key. */
export const personIdentity = pgTable("person_identity", {
  user_id: text("user_id").primaryKey(),
  microsoft_object_id: uuid("microsoft_object_id").unique(),
  group_object_ids: uuid("group_object_ids").array().notNull().default([]),
  groups_read_at: timestamptz("groups_read_at"),
});

export const syncRun = pgTable(
  "sync_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: SYNC_KINDS }).notNull(),
    trigger: text("trigger", { enum: SYNC_TRIGGERS }).notNull(),
    started_at: timestamptz("started_at").notNull().defaultNow(),
    finished_at: timestamptz("finished_at"),
    status: text("status", { enum: SYNC_STATUSES }).notNull(),
    workspaces_scanned: integer("workspaces_scanned").notNull().default(0),
    counts: jsonb("counts")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    error: text("error"),
  },
  (t) => [
    check("sync_run_kind_check", sql`${t.kind} in ('incremental', 'full')`),
    check(
      "sync_run_trigger_check",
      sql`${t.trigger} in ('schedule', 'manual', 'deploy')`,
    ),
    check(
      "sync_run_status_check",
      sql`${t.status} in ('running', 'succeeded', 'failed', 'skipped')`,
    ),
  ],
);

const ALL: readonly Privilege[] = ["select", "insert", "update", "delete"];
/** Only worker_rw writes the rest (person_identity apart); audit_writer has no part in the mirror. */
const worker = { worker_rw: ALL, audit_writer: [] } as const;

/** The api writes our own fields on a mirror table, and the few columns it reads with a person's token. */
function apiUpdates(...more: string[]): readonly Privilege[] {
  const columns = ["description", "described_by", "described_at", "custom"];
  return ["select", `update(${[...columns, ...more].join(", ")})`];
}

declareGrants({
  powerbi_workspace: { api_rw: apiUpdates("icon"), ...worker },
  powerbi_app: { api_rw: apiUpdates(), ...worker },
  powerbi_app_dataset: { api_rw: ["select"], ...worker },
  powerbi_dataset: {
    api_rw: apiUpdates(
      "icon",
      "relationships_source",
      "relationships_read_at",
      "enabled",
    ),
    ...worker,
  },
  powerbi_table: { api_rw: apiUpdates(), ...worker },
  powerbi_column: { api_rw: apiUpdates("display_folder"), ...worker },
  powerbi_measure: { api_rw: apiUpdates("display_folder"), ...worker },
  powerbi_relationship: { api_rw: ALL, ...worker },
  powerbi_access: { api_rw: ["select"], ...worker },
  // Only the api reads Power BI with a person's token, so only it keeps the reads in flight.
  model_view_read: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  // The api links a person at sign-in and reads their groups with their own
  // token, so the worker has no use for this table; an issue that needs it declares it.
  person_identity: {
    // delete: removing a deactivated person (services/admin/people.ts deletePerson).
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
  sync_run: { api_rw: ["select"], ...worker },
});
