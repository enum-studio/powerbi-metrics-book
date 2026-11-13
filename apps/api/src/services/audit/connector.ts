import { and, eq, gt, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { auditEvent } from "../../db/schema/audit.js";
import { writeAudit } from "./write.js";

/** The audit event of a client reaching the connector: the setup's agents check reads it as proof. */
export const CONNECTOR_REACHED_ACTION = "connector.whoami";
const ONCE_PER_MS = 24 * 60 * 60_000;

/**
 * Records that the caller's client reached the connector, at most once a day
 * for each principal and client, so repeated calls do not grow the log.
 */
export async function recordConnectorReached(
  context: ServiceContext,
): Promise<void> {
  const { principal, db, clock } = context;
  // audit_writer only inserts, so the lock and the look for a recent row run on db and the insert
  // on auditDb, which commits before the lock is released: parallel first calls write one row.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${CONNECTOR_REACHED_ACTION}:${principal.kind}:${principal.id}:${principal.client_id ?? ""}`}, 0))`,
    );
    const [recent] = await tx
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, CONNECTOR_REACHED_ACTION),
          eq(auditEvent.principal_kind, principal.kind),
          eq(auditEvent.principal_id, principal.id),
          principal.client_id === null
            ? undefined
            : eq(auditEvent.client_id, principal.client_id),
          gt(auditEvent.at, new Date(clock().getTime() - ONCE_PER_MS)),
        ),
      )
      .limit(1);
    if (recent !== undefined) return;
    await writeAudit(context, {
      principal,
      action: CONNECTOR_REACHED_ACTION,
      resource: null,
      decision: "allow",
    });
  });
}
