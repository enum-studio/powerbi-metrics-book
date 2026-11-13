import type { AppDeps } from "../../context.js";
import { type AuditDecision, auditEvent } from "../../db/schema/audit.js";
import type { Principal } from "../../principal.js";

export type AuditEventInput = {
  principal: Principal;
  action: string;
  resource: { kind: string; id: string } | null;
  decision: AuditDecision;
  reason?: string;
  detail?: Record<string, unknown>;
};

/**
 * Records one denial, credential change, manual sync or admin action, as
 * audit_writer. That role may insert and nothing else, so the insert returns
 * nothing: returning would need select.
 */
export async function writeAudit(
  deps: Pick<AppDeps, "auditDb">,
  event: AuditEventInput,
): Promise<void> {
  await deps.auditDb.insert(auditEvent).values({
    principal_kind: event.principal.kind,
    principal_id: event.principal.id,
    via: event.principal.via,
    client_id: event.principal.client_id,
    action: event.action,
    resource_kind: event.resource?.kind ?? null,
    resource_id: event.resource?.id ?? null,
    decision: event.decision,
    reason: event.reason ?? null,
    detail: event.detail ?? {},
  });
}
