import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../../context.js";
import { auditEvent } from "../../db/schema/audit.js";

export type AuditEvent = typeof auditEvent.$inferSelect;

export type AuditQuery = {
  /** Events at or after this moment. */
  since?: Date;
  /** A principal's id. */
  principal?: string;
  action?: string;
  limit?: number;
  /** The page after the one that ended with this id. */
  before_id?: number;
};

const DEFAULT_LIMIT = 100;

/** The newest events first, a page at a time. */
export async function readAudit(
  db: Db,
  query: AuditQuery = {},
): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvent)
    .where(
      and(
        query.since === undefined ? undefined : gte(auditEvent.at, query.since),
        query.principal === undefined
          ? undefined
          : eq(auditEvent.principal_id, query.principal),
        query.action === undefined
          ? undefined
          : eq(auditEvent.action, query.action),
        query.before_id === undefined
          ? undefined
          : lt(auditEvent.id, query.before_id),
      ),
    )
    .orderBy(desc(auditEvent.id))
    .limit(query.limit ?? DEFAULT_LIMIT);
}
