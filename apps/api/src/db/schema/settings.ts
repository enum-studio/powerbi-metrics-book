import { sql } from "drizzle-orm";
import {
  check,
  customType,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { escapeLiteral } from "pg";
import { SETTING_KEYS } from "../../services/settings/registry.js";
import { declareGrants } from "../grants.js";

/**
 * jsonb read as pg parses it, once. Drizzle's own jsonb column parses a
 * string it is handed a second time, so the saved string "123" would come
 * back as the number 123.
 */
const jsonValue = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) => value,
});

/** A setting someone saved; one that has no row has its default, or the environment's value. */
export const setting = pgTable(
  "setting",
  {
    key: text("key").primaryKey(),
    value: jsonValue("value").notNull(),
    set_by: text("set_by").notNull(),
    set_at: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The database refuses a key the registry does not know, whoever writes
    // it. The keys are literals: DDL takes no parameters.
    check(
      "setting_key_known",
      sql`${table.key} in (${sql.raw(SETTING_KEYS.map(escapeLiteral).join(", "))})`,
    ),
  ],
);

declareGrants({
  setting: {
    api_rw: ["select", "insert", "update"],
    worker_rw: ["select"],
    audit_writer: [],
  },
});
