import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

export type AuditDecision = "allow" | "deny";

/** Every denial, credential change, manual sync and admin action; inserted by audit_writer, never changed. */
export const auditEvent = pgTable(
  "audit_event",
  {
    // The spec's bigserial, as an identity column: its sequence needs no
    // grant of its own, and audit_writer is granted insert and nothing else.
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    principal_kind: text("principal_kind").notNull(),
    principal_id: text("principal_id").notNull(),
    via: text("via").notNull(),
    client_id: text("client_id"),
    action: text("action").notNull(),
    resource_kind: text("resource_kind"),
    resource_id: text("resource_id"),
    decision: text("decision").$type<AuditDecision>().notNull(),
    reason: text("reason"),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => [
    check("audit_event_decision", sql`${table.decision} in ('allow', 'deny')`),
    index("audit_event_at").on(table.at),
  ],
);

declareGrants({
  audit_event: {
    api_rw: ["select"],
    worker_rw: ["select"],
    audit_writer: ["insert"],
  },
});
