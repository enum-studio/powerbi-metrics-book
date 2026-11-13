import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { myGroupIds } from "../../powerbi/graph.js";
import type { DelegatedTokens } from "../../powerbi/identity.js";
import {
  endConnection,
  enforceOwnAccount,
  lockConnection,
  spendRefreshToken,
} from "./store.js";

/** Groups read longer ago than this are read again the next time the person uses the connection. */
const GROUPS_FRESH_MS = 24 * 60 * 60_000;

/**
 * Reads the connected account's groups for visibility, and for roles only
 * when it is the person's own account. The
 * refresh token is spent for Graph under the row lock and its replacement
 * committed before Graph is asked, so a failing Graph never loses it. The
 * groups are written only if the connection is still the one this read
 * spent: a disconnect or an ended connection meanwhile is never undone.
 */
export async function readGroups(
  deps: AppDeps,
  userId: string,
  onUse = false,
): Promise<void> {
  const spent = await deps.db.transaction(async (tx) => {
    const row = await lockConnection(tx, userId, onUse);
    if (
      row?.status !== "connected" ||
      !(await enforceOwnAccount(deps, tx, row))
    )
      return null;
    const now = deps.clock();
    if (
      onUse &&
      (now.getTime() - (row.groups_read_at?.getTime() ?? 0) < GROUPS_FRESH_MS ||
        now.getTime() - (row.groups_attempted_at?.getTime() ?? 0) < 5 * 60_000)
    )
      return null;
    await tx
      .update(powerbiConnection)
      .set({ groups_attempted_at: now })
      .where(eq(powerbiConnection.id, row.id));
    let graph: DelegatedTokens | null;
    try {
      graph = await spendRefreshToken(deps, tx, row, "graph");
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      return { error };
    }
    const after = graph === null ? null : await lockConnection(tx, userId);
    return graph === null || after?.refreshed_at == null
      ? null
      : {
          token: graph.access_token,
          oid: row.microsoft_object_id,
          connected_at: row.connected_at.getTime(),
          refreshed_at: after.refreshed_at.getTime(),
        };
  });
  if (spent === null) return;
  if (spent.error !== undefined) throw spent.error;
  let groups: string[];
  try {
    groups = await myGroupIds(deps, spent.token);
  } catch (error) {
    if (error instanceof ServiceError && error.kind === "needs_connection")
      await deps.db.transaction(async (tx) => {
        const row = await lockConnection(tx, userId);
        if (
          row?.status === "connected" &&
          row.microsoft_object_id === spent.oid &&
          row.connected_at.getTime() === spent.connected_at
        )
          await endConnection(tx, userId, {
            status: "needs_reconnect",
            last_error: error.message,
          });
      });
    throw error;
  }
  await deps.db.transaction(async (tx) => {
    const row = await lockConnection(tx, userId);
    if (
      row?.status !== "connected" ||
      row.microsoft_object_id !== spent.oid ||
      row.refreshed_at?.getTime() !== spent.refreshed_at
    )
      return;
    const values = {
      group_object_ids: groups,
      groups_read_at: deps.clock(),
    };
    await tx
      .update(powerbiConnection)
      .set(values)
      .where(eq(powerbiConnection.user_id, userId));
    await tx
      .update(personIdentity)
      .set(values)
      .where(
        and(
          eq(personIdentity.user_id, userId),
          eq(personIdentity.microsoft_object_id, spent.oid),
        ),
      );
  });
}

/** On use: the person's groups, when they were read more than a day ago. */
export async function refreshStaleGroups(
  deps: AppDeps,
  userId: string,
): Promise<void> {
  const [identity] = await deps.db
    .select({ groups_read_at: powerbiConnection.groups_read_at })
    .from(powerbiConnection)
    .where(
      and(
        eq(powerbiConnection.user_id, userId),
        eq(powerbiConnection.status, "connected"),
      ),
    );
  if (identity === undefined) return;
  const readAt = identity.groups_read_at?.getTime() ?? 0;
  if (deps.clock().getTime() - readAt < GROUPS_FRESH_MS) return;
  await readGroups(deps, userId, true);
}
