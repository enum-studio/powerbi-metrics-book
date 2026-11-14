import { and, eq } from "drizzle-orm";
import pg from "pg";
import { connectAgain, connectionsPage, type Config } from "../../config.js";
import type { AppDeps, Db, Vault } from "../../context.js";
import {
  type ConnectionStatus,
  powerbiConnection,
} from "../../db/schema/connection.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import { type DelegatedTokens, refresh } from "../../powerbi/identity.js";
import { readIdentity } from "../auth/roles.js";

/*
 * Where a person's Power BI tokens are kept: age ciphertext sealed by the
 * api's vault. Every change to a connection's tokens runs with its row
 * locked (select ... for update).
 */

export type Connection = typeof powerbiConnection.$inferSelect;
export type OpenTokens = { access_token: string; refresh_token: string };
export const ownAccountRequired = (config: Config) =>
  `This deployment now requires your own Microsoft account. ${connectAgain(config)}`;

export async function enforceOwnAccount(
  deps: AppDeps,
  tx: Db,
  row: Connection,
) {
  if (!(await deps.settings.get("powerbi.connection_requires_matching_email")))
    return true;
  const own = await readIdentity(tx, row.user_id);
  if (own?.microsoft_object_id === row.microsoft_object_id) return true;
  await endConnection(tx, row.user_id, {
    status: "needs_reconnect",
    last_error: ownAccountRequired(deps.config),
  });
  return false;
}

/** A connection that is not connected holds no token. */
export const NO_TOKENS = {
  access_token_ciphertext: null,
  access_token_expires_at: null,
  refresh_token_ciphertext: null,
  recipient: null,
} as const;

export const accountTaken = () =>
  new ServiceError(
    "conflict",
    "This Microsoft account is connected to another person already.",
  );

/**
 * Runs a statement whose parameters hold a ciphertext or a PKCE verifier.
 * Drizzle's error repeats the parameters and Postgres's detail the row, so
 * a failure is answered with Postgres's message alone; the same account
 * connected by two people at once answers as admit does.
 */
export async function hidingValues<T>(statement: PromiseLike<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause instanceof pg.DatabaseError &&
      cause.code === "23505" &&
      cause.constraint?.endsWith("_microsoft_object_id_unique") === true
    )
      throw accountTaken();
    // Postgres's own message, not drizzle's with the ciphertext. It can quote only
    // a value it could not read as its type, and ciphertext goes as bytes.
    const reason = cause instanceof Error ? cause.message : "no reason given";
    throw new Error(`a Power BI connection write failed: ${reason}`);
  }
}

export async function sealTokens(vault: Vault, tokens: DelegatedTokens) {
  return {
    access_token_ciphertext: await vault.seal(tokens.access_token),
    access_token_expires_at: tokens.expires_at,
    refresh_token_ciphertext: await vault.seal(tokens.refresh_token),
    recipient: vault.recipient,
    scopes: tokens.scopes,
  };
}

export async function lockConnection(
  tx: Db,
  userId: string,
  skipLocked = false,
): Promise<Connection | null> {
  const [row] = await tx
    .select()
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, userId))
    .for("update", skipLocked ? { skipLocked: true } : {});
  return row ?? null;
}

/**
 * Ends a connection: both tokens deleted, and its groups no longer counted
 * as tenant membership (roles.ts reads groups_read_at).
 */
export async function endConnection(
  tx: Db,
  userId: string,
  change: { status: "needs_reconnect" | "disconnected"; last_error?: string },
): Promise<void> {
  const ended = await tx
    .update(powerbiConnection)
    .set({ ...NO_TOKENS, ...change, groups_read_at: null })
    .where(eq(powerbiConnection.user_id, userId))
    .returning({ oid: powerbiConnection.microsoft_object_id });
  if (ended[0] !== undefined)
    await tx
      .update(personIdentity)
      .set({ groups_read_at: null })
      .where(
        and(
          eq(personIdentity.user_id, userId),
          eq(personIdentity.microsoft_object_id, ended[0].oid),
        ),
      );
}

/**
 * The tokens of a connected row locked by tx; null for one that is not
 * connected. A row sealed by an identity rotate-identity retired is sealed
 * again by the vault's own.
 */
export async function openTokens(
  deps: Pick<AppDeps, "vault" | "config">,
  tx: Db,
  row: Connection,
): Promise<OpenTokens | null> {
  const { access_token_ciphertext, refresh_token_ciphertext, recipient } = row;
  if (
    row.status !== "connected" ||
    access_token_ciphertext === null ||
    refresh_token_ciphertext === null
  )
    return null;
  const { vault } = deps;
  const open = async () => ({
    access_token: await vault.open(access_token_ciphertext),
    refresh_token: await vault.open(refresh_token_ciphertext),
  });
  if (recipient === vault.recipient) return open();
  let tokens: OpenTokens;
  try {
    tokens = await open();
  } catch {
    // A lost identity volume: no key here opens the tokens any more.
    throw new ServiceError(
      "needs_connection",
      `Your Power BI connection is sealed with a key this api no longer holds. Reconnect at ${connectionsPage(deps.config)}`,
    );
  }
  await hidingValues(
    tx
      .update(powerbiConnection)
      .set({
        access_token_ciphertext: await vault.seal(tokens.access_token),
        refresh_token_ciphertext: await vault.seal(tokens.refresh_token),
        recipient: vault.recipient,
      })
      .where(eq(powerbiConnection.id, row.id)),
  );
  return tokens;
}

/**
 * Spends the refresh token of a row locked by tx and stores the one
 * Microsoft answers in its place, in the same transaction; for Power BI
 * the new access token too. A refresh token Microsoft refuses
 * (invalid_grant) ends the connection and answers null.
 */
export async function spendRefreshToken(
  deps: AppDeps,
  tx: Db,
  row: Connection,
  resource: "powerbi" | "graph",
): Promise<DelegatedTokens | null> {
  const open = await openTokens(deps, tx, row);
  if (open === null) return null;
  let fresh: DelegatedTokens;
  try {
    fresh = await refresh(deps, open.refresh_token, resource);
  } catch (error) {
    if (!(error instanceof ServiceError && error.kind === "needs_connection"))
      throw error;
    await endConnection(tx, row.user_id, {
      status: "needs_reconnect",
      last_error: error.message,
    });
    deps.logger.warn("Power BI connection ended", { user_id: row.user_id });
    return null;
  }
  const sealed =
    resource === "powerbi"
      ? await sealTokens(deps.vault, fresh)
      : {
          refresh_token_ciphertext: await deps.vault.seal(fresh.refresh_token),
        };
  await hidingValues(
    tx
      .update(powerbiConnection)
      .set({ ...sealed, refreshed_at: deps.clock(), last_error: null })
      .where(eq(powerbiConnection.id, row.id)),
  );
  return fresh;
}

/** The connection's state as /api/v1/me reports it. */
export async function connectionState(
  db: Db,
  userId: string,
): Promise<ConnectionStatus | "not_connected"> {
  const [row] = await db
    .select({ status: powerbiConnection.status })
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, userId));
  return row?.status ?? "not_connected";
}

/**
 * A person's connection as their connections page shows it: the Microsoft
 * account it is, when it was made and last used, and why it ended when it
 * needs a reconnect. last_error is always this api's own sentence.
 */
export async function connectionDetails(
  db: Db,
  userId: string,
): Promise<{
  status: ConnectionStatus | "not_connected";
  account: string | null;
  connected_at: string | null;
  last_used_at: string | null;
  reason: string | null;
}> {
  const [row] = await db
    .select({
      status: powerbiConnection.status,
      account: powerbiConnection.user_principal_name,
      connected_at: powerbiConnection.connected_at,
      last_used_at: powerbiConnection.last_used_at,
      last_error: powerbiConnection.last_error,
    })
    .from(powerbiConnection)
    .where(eq(powerbiConnection.user_id, userId));
  if (row === undefined)
    return {
      status: "not_connected",
      account: null,
      connected_at: null,
      last_used_at: null,
      reason: null,
    };
  return {
    status: row.status,
    account: row.account,
    connected_at: row.connected_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    reason: row.status === "needs_reconnect" ? row.last_error : null,
  };
}
