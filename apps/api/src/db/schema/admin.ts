import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

export const SETTING_CHECK_DETAILS_MAX_BYTES = 262144;

/**
 * The last result of a check registered for a setting key or a setup step.
 * A secret's check is kept on its own row in `secret`.
 */
export const settingCheck = pgTable(
  "setting_check",
  {
    key: text("key").primaryKey(),
    status: text("status", { enum: ["passing", "failing"] }).notNull(),
    message: text("message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    action: text("action", { enum: ["sign_in", "connect"] }),
    checked_at: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("setting_check_status", sql`${t.status} in ('passing', 'failing')`),
    check("setting_check_key", sql`${t.key} ~ '^[a-z][a-z0-9_.]*$'`),
    check("setting_check_message", sql`char_length(${t.message}) <= 300`),
    check(
      "setting_check_details",
      sql`${t.details} is null or (jsonb_typeof(${t.details}) = 'object' and octet_length(${t.details}::text) <= ${sql.raw(String(SETTING_CHECK_DETAILS_MAX_BYTES))})`,
    ),
    check("setting_check_action", sql`${t.action} in ('sign_in', 'connect')`),
    // Row level security: the api keeps every result; the worker reads and
    // writes only those of the checks it alone runs (services/setup/worker-checks.ts).
    pgPolicy("setting_check_api", {
      for: "all",
      to: "api_rw",
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("setting_check_worker", {
      for: "all",
      to: "worker_rw",
      using: sql`${t.key} in ('scanner', 'what_to_sync')`,
      withCheck: sql`${t.key} in ('scanner', 'what_to_sync')`,
    }),
  ],
);

// The worker stores the results of the checks only it can run, on their rows alone (above).
declareGrants({
  setting_check: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: ["select", "insert", "update"],
    audit_writer: [],
  },
});
