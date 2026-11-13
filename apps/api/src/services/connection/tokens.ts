import { eq } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { ServiceError } from "../../errors.js";
import {
  connectionsPage,
  enforceOwnAccount,
  lockConnection,
  OWN_ACCOUNT_REQUIRED,
  openTokens,
  spendRefreshToken,
} from "./store.js";

/** An access token this close to its expiry is refreshed before a query uses it. */
const RENEW_WITHIN_MS = 5 * 60_000;
/**
 * A forced refresh within this long of the last one is ignored: two queries
 * Power BI refused at once spend one refresh token, and a 401 that
 * persists is not a stale token.
 */
const FORCED_AGAIN_AFTER_MS = 60_000;

/**
 * The calling person's Power BI access token, for the query service to
 * send to Power BI and nowhere else: never returned to a client or logged.
 * Refreshed under the row lock when it expires within five minutes, or
 * when force_refresh says Power BI refused it, so two queries at once never
 * spend the same refresh token.
 */
export async function personPowerBiGrant(
  context: ServiceContext,
  options: { force_refresh?: boolean } = {},
): Promise<{ token: string; account: string | null }> {
  const { principal } = context;
  if (principal.kind !== "person")
    throw new ServiceError(
      "refused",
      "Only a person has a Power BI connection.",
    );
  const page = connectionsPage(context.config);
  const found = await context.db.transaction(async (tx) => {
    const row = await lockConnection(tx, principal.id);
    if (row === null || row.status === "disconnected") return "none";
    if (!(await enforceOwnAccount(context, tx, row))) return "own_account";
    const now = context.clock();
    const expiresAt = row.access_token_expires_at?.getTime() ?? 0;
    const lastRefresh = row.refreshed_at?.getTime() ?? 0;
    const forced =
      options.force_refresh === true &&
      now.getTime() - lastRefresh >= FORCED_AGAIN_AFTER_MS;
    const renew = forced || expiresAt - now.getTime() < RENEW_WITHIN_MS;
    const token = renew
      ? (await spendRefreshToken(context, tx, row, "powerbi"))?.access_token
      : (await openTokens(context, tx, row))?.access_token;
    // An ended connection's change must commit before its error is thrown.
    if (token === undefined) return "ended";
    await tx
      .update(powerbiConnection)
      .set({ last_used_at: now })
      .where(eq(powerbiConnection.id, row.id));
    return { token, account: row.user_principal_name };
  });
  if (found === "none")
    throw new ServiceError("needs_connection", `Connect Power BI at ${page}`);
  if (found === "own_account")
    throw new ServiceError("needs_connection", OWN_ACCOUNT_REQUIRED);
  if (found === "ended")
    throw new ServiceError(
      "needs_connection",
      `Your Power BI connection expired. Reconnect at ${page}`,
    );
  return found;
}
