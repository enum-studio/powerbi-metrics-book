import type { ServiceContext } from "../../context.js";
import { writeAudit } from "../audit/write.js";

/*
 * Every admin service asks Cerbos for its own action on the admin resource
 * first, and records each change it makes. A service account is refused
 * every admin action but read_status in code (services/access/cerbos.ts),
 * whatever a policy grants it.
 */

const admin = (action: string) => ({
  kind: "admin" as const,
  id: action,
  attr: {},
});

export async function requireAdmin(
  context: ServiceContext,
  action: string,
): Promise<void> {
  await context.access.require(context.principal, admin(action), action);
}

export function mayAdmin(
  context: Pick<ServiceContext, "access" | "principal">,
  action: string,
): Promise<boolean> {
  return context.access.check(context.principal, admin(action), action);
}

/** The detail names what changed, never a secret's value, a key or a token. */
export function audited(
  context: ServiceContext,
  action: string,
  resource: { kind: string; id: string },
  detail: Record<string, unknown> = {},
  reason?: string,
): Promise<void> {
  return writeAudit(context, {
    principal: context.principal,
    action: `admin.${action}`,
    resource,
    decision: "allow",
    detail,
    ...(reason === undefined ? {} : { reason }),
  });
}
