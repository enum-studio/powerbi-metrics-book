import { and, asc, eq, gt, lt, ne, notExists, sql } from "drizzle-orm";
import type { AppDeps, Db } from "../../context.js";
import {
  deviceCode,
  oauthAccessToken,
  oauthClient,
  oauthClientActivity,
  oauthConsent,
  oauthConsentUse,
  oauthRefreshToken,
  session,
  verification,
} from "../../db/schema/auth.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";

/** The CLI's own client, registered by the api at start (device.ts). */
export const CLI_CLIENT_ID = "pbmb-cli";

/** A person's consent to one MCP client or the CLI, as /api/v1/me/grants lists it. */
export type Grant = {
  id: string;
  client_id: string;
  client_name: string | null;
  via: "mcp" | "cli";
  scopes: string[];
  granted_at: string;
  /** When an access token of this grant last reached the connector or the API, to the minute. */
  last_used_at: string | null;
};

/**
 * Ends a grant at once: the consent goes first, which stops every access
 * token it covers on the next request (oauth.ts), then the refresh and
 * stored access tokens.
 */
export async function revokeGrantOf(
  db: Db,
  client_id: string,
  user_id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.clientId, client_id),
          eq(oauthConsent.userId, user_id),
        ),
      );
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.clientId, client_id),
          eq(oauthAccessToken.userId, user_id),
        ),
      );
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.clientId, client_id),
          eq(oauthRefreshToken.userId, user_id),
        ),
      );
  });
}

export async function revokeGrantsOf(db: Db, user_id: string): Promise<void> {
  const clients = await db
    .select({ id: oauthConsent.clientId })
    .from(oauthConsent)
    .where(eq(oauthConsent.userId, user_id));
  for (const client of clients) await revokeGrantOf(db, client.id, user_id);
}

/** How the OAuth provider's stored value of an authorization code begins, as a LIKE pattern. */
const AUTHORIZATION_CODE = '{"type":"authorization\\_code",%';

/**
 * Signs a person out everywhere: every browser session of theirs ends, and
 * every MCP and CLI grant, so each client must sign in again. Their codes
 * not yet exchanged end too, so none mints a token once they allow the same
 * client again.
 */
export async function signOutEverywhere(
  db: Db,
  user_id: string,
): Promise<void> {
  await db.delete(session).where(eq(session.userId, user_id));
  await revokeGrantsOf(db, user_id);
  await db.delete(deviceCode).where(eq(deviceCode.userId, user_id));
  // The OAuth provider keeps a code as a verification row: its identifier is
  // the code's digest, its value JSON whose first key is the type. The CASE
  // reads JSON only from those rows; other kinds need not be JSON.
  await db
    .delete(verification)
    .where(
      sql`case when ${verification.value} like ${AUTHORIZATION_CODE} then ${verification.value}::jsonb ->> 'userId' end = ${user_id}`,
    );
}

/** How long a client no person has allowed is kept: metadata-document and registered clients arrive unasked. */
const IDLE_CLIENT_MS = 24 * 60 * 60 * 1000;
/** A consent request's signature and then its code each last 10 minutes. */
const PENDING_MS = 20 * 60 * 1000;

/** Records that a client asked to authorize, if it exists, for pruneIdleClients. */
export async function noteAuthorization(
  db: Db,
  client_id: string,
  now: Date,
): Promise<void> {
  await db
    .insert(oauthClientActivity)
    .select(
      db
        .select({
          client_id: oauthClient.clientId,
          authorized_at: sql<Date>`${now}::timestamptz`.as("authorized_at"),
        })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, client_id)),
    )
    .onConflictDoUpdate({
      target: oauthClientActivity.client_id,
      set: { authorized_at: now },
    });
}

/** A grant's last use is noted at most this often, so a busy agent does not write on every call. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * Notes that an access token of this grant was just accepted, when its last
 * use is older than a minute, and says whether the grant still stands. The
 * age is checked here to spare most requests a write, and in the statement
 * so replicas racing on one grant write it once. The consent is read FOR
 * KEY SHARE: a revoke running at the same moment is waited for, and then
 * nothing is written and the grant no longer stands, so the token is
 * refused rather than served after its grant ended.
 */
export async function noteGrantUse(
  db: Db,
  grant: { id: string; last_used_at: Date | null },
  now: Date,
): Promise<boolean> {
  const stale = new Date(now.getTime() - LAST_USED_EVERY_MS);
  if (grant.last_used_at !== null && grant.last_used_at >= stale) return true;
  const { rows } = await db.execute<{ id: string }>(sql`
    with consent as (
      select ${oauthConsent.id} as id from ${oauthConsent}
      where ${oauthConsent.id} = ${grant.id}
      for key share
    ), noted as (
      insert into ${oauthConsentUse} (consent_id, last_used_at)
      select id, ${now}::timestamptz from consent
      on conflict (consent_id) do update set last_used_at = excluded.last_used_at
      where ${oauthConsentUse.last_used_at} < ${stale}::timestamptz
    )
    select id from consent`);
  return rows.length > 0;
}

/**
 * Run when a client is created, so oauth_client cannot grow without bound:
 * deletes clients unchanged for a day that no person consented to and none
 * is authorizing, but the CLI's.
 */
export async function pruneIdleClients(db: Db, now: Date): Promise<void> {
  const consents = db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(eq(oauthConsent.clientId, oauthClient.clientId));
  const pending = db
    .select({ id: oauthClientActivity.client_id })
    .from(oauthClientActivity)
    .where(
      and(
        eq(oauthClientActivity.client_id, oauthClient.clientId),
        gt(
          oauthClientActivity.authorized_at,
          new Date(now.getTime() - PENDING_MS),
        ),
      ),
    );
  const changed = sql`coalesce(${oauthClient.updatedAt}, ${oauthClient.createdAt})`;
  await db
    .delete(oauthClient)
    .where(
      and(
        ne(oauthClient.clientId, CLI_CLIENT_ID),
        lt(changed, new Date(now.getTime() - IDLE_CLIENT_MS)),
        notExists(consents),
        notExists(pending),
      ),
    );
}

const grantColumns = {
  id: oauthConsent.id,
  client_id: oauthConsent.clientId,
  client_name: oauthClient.name,
  scopes: oauthConsent.scopes,
  created_at: oauthConsent.createdAt,
  used_at: oauthConsentUse.last_used_at,
};

function toGrant({
  created_at,
  used_at,
  ...grant
}: {
  id: string;
  client_id: string;
  client_name: string | null;
  scopes: string[];
  created_at: Date;
  used_at: Date | null;
}): Grant {
  return {
    ...grant,
    via: grant.client_id === CLI_CLIENT_ID ? "cli" : "mcp",
    granted_at: created_at.toISOString(),
    last_used_at: used_at?.toISOString() ?? null,
  };
}

export async function listGrants(
  deps: AppDeps,
  principal: Principal,
): Promise<Grant[]> {
  const rows = await deps.db
    .select(grantColumns)
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(oauthConsentUse, eq(oauthConsentUse.consent_id, oauthConsent.id))
    .where(eq(oauthConsent.userId, principal.id))
    .orderBy(asc(oauthConsent.createdAt));
  return rows.map(toGrant);
}

/** Every person's grants by user id, oldest first, for the admin's people list. */
export async function listAllGrants(db: Db): Promise<Map<string, Grant[]>> {
  const rows = await db
    .select({ ...grantColumns, user_id: oauthConsent.userId })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(oauthConsentUse, eq(oauthConsentUse.consent_id, oauthConsent.id))
    .orderBy(asc(oauthConsent.createdAt));
  const byPerson = new Map<string, Grant[]>();
  for (const { user_id, ...row } of rows) {
    if (user_id === null) continue;
    byPerson.set(user_id, [...(byPerson.get(user_id) ?? []), toGrant(row)]);
  }
  return byPerson;
}

async function grantById(
  deps: AppDeps,
  id: string,
): Promise<{ client_id: string; user_id: string | null } | undefined> {
  const [grant] = await deps.db
    .select({ client_id: oauthConsent.clientId, user_id: oauthConsent.userId })
    .from(oauthConsent)
    .where(eq(oauthConsent.id, id));
  return grant;
}

const NO_GRANT = "No such connection. List yours at /api/v1/me/grants.";

/** A person ends one of their own grants. Another person's answers like a missing one. */
export async function revokeGrant(
  deps: AppDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const grant = await grantById(deps, id);
  if (grant?.user_id !== principal.id)
    throw new ServiceError("not_found", NO_GRANT);
  await revokeGrantOf(deps.db, grant.client_id, principal.id);
}

/** An admin ends anyone's grant: the admin section's revoke_connection. */
export async function revokeConnection(
  deps: AppDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  await deps.access.require(
    principal,
    { kind: "admin", id: "connections", attr: {} },
    "revoke_connection",
  );
  const grant = await grantById(deps, id);
  if (grant?.user_id == null) throw new ServiceError("not_found", NO_GRANT);
  await revokeGrantOf(deps.db, grant.client_id, grant.user_id);
}
