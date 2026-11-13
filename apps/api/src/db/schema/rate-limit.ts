import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

/**
 * Request counts per key and fixed window, so every api replica shares one
 * limit. One row per key: a later window replaces the last. The worker
 * deletes counts a day old. Better Auth keeps its own counts for sign-in, in
 * rate_limit.
 */
export const requestRate = pgTable("request_rate", {
  key: text("key").primaryKey(),
  window_start: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

declareGrants({
  request_rate: {
    api_rw: ["select", "insert", "update"],
    worker_rw: ["select", "delete"],
    audit_writer: [],
  },
});
