import { sql } from "drizzle-orm";
import { boolean, check, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

/**
 * The tenant this database belongs to, for life: one row at most (id is
 * always true), written once when the setup confirms the first admin.
 * `sample` is whether Microsoft identity was the mock then. Nothing updates
 * or deletes the row, so moving to another tenant is a new database.
 */
export const deploymentTenant = pgTable(
  "deployment_tenant",
  {
    id: boolean("id").primaryKey().notNull().default(true),
    tenant_id: uuid("tenant_id").notNull(),
    sample: boolean("sample").notNull(),
    bound_at: timestamp("bound_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("deployment_tenant_single_row", sql`${table.id}`)],
);

declareGrants({
  deployment_tenant: {
    api_rw: ["select", "insert"],
    worker_rw: ["select"],
    audit_writer: [],
  },
});
