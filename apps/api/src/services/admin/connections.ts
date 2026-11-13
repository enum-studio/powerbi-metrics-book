import { eq } from "drizzle-orm";
import pg from "pg";
import type { ServiceContext } from "../../context.js";
import { oauthConsent } from "../../db/schema/auth.js";
import { ServiceError } from "../../errors.js";
import { revokeConnection } from "../auth/grants.js";
import { audited, requireAdmin } from "./guard.js";

/**
 * Ends any person's MCP or CLI grant (admin:revoke_connection) and records
 * whose it was and which client, which the consent's row no longer says
 * once it is gone. An id no grant has answers like a missing one. The grant
 * ends first, so a failed audit write leaves it ended and untraced in the
 * audit log; the log line names the grant, the person and the client then.
 */
export async function revokeConnectionAs(
  context: ServiceContext,
  id: string,
): Promise<void> {
  await requireAdmin(context, "revoke_connection");
  const [grant] = await context.db
    .select({ user_id: oauthConsent.userId, client_id: oauthConsent.clientId })
    .from(oauthConsent)
    .where(eq(oauthConsent.id, id));
  if (grant === undefined)
    throw new ServiceError("not_found", "No such connection.");
  await revokeConnection(context, context.principal, id);
  try {
    await audited(context, "connection.revoke", { kind: "grant", id }, grant);
  } catch (error) {
    // The error's own text is left out: a failed query's message holds its parameters.
    context.logger.error("a revoked connection was not audited", {
      grant_id: id,
      revoked_by: context.principal.id,
      ...grant,
      error:
        error instanceof Error
          ? `${error.name}${error.cause instanceof pg.DatabaseError ? ` ${error.cause.code ?? ""}` : ""}`
          : "unknown",
    });
    throw error;
  }
}
