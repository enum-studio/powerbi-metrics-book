import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";
import { user } from "./auth.js";

/**
 * A person an admin deactivated: while the row exists they hold no role and
 * cannot sign in. Their role assignments stay, so reactivating, which deletes
 * the row, gives them back as they were.
 */
export const personDeactivation = pgTable("person_deactivation", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  deactivated_at: timestamp("deactivated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deactivated_by: text("deactivated_by").notNull(),
});

declareGrants({
  person_deactivation: {
    api_rw: ["select", "insert", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
});
