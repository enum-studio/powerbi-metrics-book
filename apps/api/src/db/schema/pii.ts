import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

export const PII_RULE_KINDS = ["column", "measure", "table"] as const;
export type PiiRuleKind = (typeof PII_RULE_KINDS)[number];

/**
 * The key every rule name and mirror name is compared under, in SQL only:
 * NFKC, lower case, then the four letters NFKC and lower() leave apart from
 * the form they match. Analysis Services resolves names under the model's
 * collation, usually case- and width-insensitive; this approximates that.
 * `lower()` folds non-ASCII letters only when the database's LC_CTYPE is not C.
 */
export function foldSql(expr: SQL | AnyColumn): SQL<string> {
  return sql<string>`replace(replace(replace(replace(lower(normalize(${expr}, NFKC)), 'ß', 'ss'), 'ſ', 's'), 'ı', 'i'), 'ς', 'σ')`;
}

/**
 * An admin's ruling on a name: this column, this measure or every column of
 * this table is personal data (pii), or was reviewed and is not. Rules are by
 * name, so one covers every dataset that copies the table; names match
 * under `foldSql`.
 */
export const piiRule = pgTable(
  "pii_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: PII_RULE_KINDS }).notNull(),
    table_name: text("table_name").notNull(),
    /** Null exactly when kind is `table`. */
    name: text("name"),
    pii: boolean("pii").notNull(),
    note: text("note"),
    set_by_kind: text("set_by_kind").notNull(),
    set_by_id: text("set_by_id").notNull(),
    /** `browser`, `cli`, `mcp` or `api`. */
    set_via: text("set_via").notNull(),
    set_at: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pii_rule_name_idx").on(
      t.kind,
      foldSql(sql`${t.table_name}`),
      foldSql(sql`coalesce(${t.name}, '')`),
    ),
    check("pii_rule_kind", sql`${t.kind} in ('column', 'measure', 'table')`),
    check("pii_rule_name", sql`(${t.kind} = 'table') = (${t.name} is null)`),
    check(
      "pii_rule_table_name_length",
      sql`char_length(${t.table_name}) <= 200`,
    ),
    check("pii_rule_name_length", sql`char_length(${t.name}) <= 200`),
    check("pii_rule_note_length", sql`char_length(${t.note}) <= 500`),
  ],
);

declareGrants({
  pii_rule: {
    api_rw: ["select", "insert", "update", "delete"],
    // The search documents and the drafter read the rules.
    worker_rw: ["select"],
    audit_writer: [],
  },
});
