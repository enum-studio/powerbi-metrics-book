import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, ne, or } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { AppDeps, ServiceContext } from "../../context.js";
import {
  powerbiConnection,
  powerbiConnectState,
} from "../../db/schema/connection.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { ServiceError } from "../../errors.js";
import {
  authorizationUrl,
  CONNECTION_SCOPES,
  type RedeemedCode,
  redeemCode,
} from "../../powerbi/identity.js";
import { writeAudit } from "../audit/write.js";
import { readGroups } from "./groups.js";
import {
  accountTaken,
  connectionsPage,
  endConnection,
  hidingValues,
  ownAccountRequired,
  sealTokens,
} from "./store.js";

/*
 * Connecting a person's Power BI: the authorization code flow with PKCE
 * S256 against the app registration, from a browser session. Microsoft's
 * sign-in chains here too: its callbackURL is the connect path, with next.
 */

const STATE_LIFETIME_MS = 10 * 60_000;
/** The SPA's home and the screens a browser may be sent back to, each with the pages under it. */
const RETURN_PATH =
  /^\/(?:(?:setup|admin|settings|review|catalog|oauth\/consent|device)(?:\/|$)|$)/;
const DEFAULT_RETURN = "/settings/connections";

const sha256 = (text: string, encoding: "hex" | "base64url") =>
  createHash("sha256").update(text).digest(encoding);

function redirectUri(config: Config): string {
  return `${config.public_base_url.href.replace(/\/$/, "")}/api/v1/powerbi/callback`;
}

/**
 * Where the browser goes after connecting: a page of the SPA, with its
 * query, given as a path; anything else, another origin above all, is
 * refused before Microsoft is asked.
 */
export function returnPath(config: Config, next: string | undefined): string {
  if (next === undefined || next === "") return DEFAULT_RETURN;
  const base = config.public_base_url;
  const url = URL.parse(next, base.href);
  if (
    url === null ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    /[\\\p{Cc}]/u.test(next) ||
    url.origin !== base.origin ||
    !RETURN_PATH.test(url.pathname)
  )
    throw new ServiceError(
      "invalid",
      "next must be a page of this app, such as /settings/connections.",
    );
  return `${url.pathname}${url.search}`;
}

/** Who connects: the browser session's person, as the routes read them. */
export type BrowserPerson = {
  user_id: string;
  email: string;
  email_verified: boolean;
  session_id: string;
};

/**
 * Starts the round trip: a state bound to the session, kept in Postgres in
 * place of the session's earlier ones, and Microsoft's authorize URL.
 */
export async function startConnection(
  deps: AppDeps,
  person: BrowserPerson,
  next: string | undefined,
): Promise<string> {
  const back = returnPath(deps.config, next);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const now = deps.clock();
  await deps.db
    .delete(powerbiConnectState)
    .where(
      or(
        lt(powerbiConnectState.expires_at, now),
        eq(powerbiConnectState.session_id, person.session_id),
      ),
    );
  await hidingValues(
    deps.db.insert(powerbiConnectState).values({
      state_digest: sha256(state, "hex"),
      session_id: person.session_id,
      code_verifier: codeVerifier,
      next: back,
      expires_at: new Date(now.getTime() + STATE_LIFETIME_MS),
    }),
  );
  return authorizationUrl(deps, {
    state,
    code_challenge: sha256(codeVerifier, "base64url"),
    login_hint: person.email,
    scopes: CONNECTION_SCOPES,
    redirect_uri: redirectUri(deps.config),
  });
}

/**
 * Microsoft's redirect back: the state spent, the code redeemed, the
 * account checked against the person, then the tokens sealed for the api
 * and the person's groups read. Answers where the browser goes next. A
 * refusal is audited with its reason.
 */
export async function finishConnection(
  context: ServiceContext,
  person: BrowserPerson,
  query: { state: string | undefined; code: string | undefined },
): Promise<string> {
  const audit = (decision: "allow" | "deny", reason?: string) =>
    writeAudit(context, {
      principal: context.principal,
      action: "powerbi.connect",
      resource: { kind: "powerbi_connection", id: person.user_id },
      decision,
      ...(reason === undefined ? {} : { reason }),
    });
  let next: string;
  try {
    next = await connectAccount(context, person, query);
  } catch (error) {
    if (
      error instanceof ServiceError &&
      ["refused", "conflict", "needs_connection"].includes(error.kind)
    )
      await audit("deny", error.message);
    throw error;
  }
  await audit("allow");
  try {
    await readGroups(context, person.user_id);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    throw new ServiceError(
      "upstream",
      `Power BI is connected, but your groups were not read yet: ${error.message} They are read again on your next query.`,
      error.detail,
    );
  }
  return next;
}

async function connectAccount(
  deps: ServiceContext,
  person: BrowserPerson,
  query: { state: string | undefined; code: string | undefined },
): Promise<string> {
  const [started] =
    query.state === undefined
      ? []
      : await deps.db
          .delete(powerbiConnectState)
          .where(
            eq(powerbiConnectState.state_digest, sha256(query.state, "hex")),
          )
          .returning();
  if (
    started === undefined ||
    started.session_id !== person.session_id ||
    started.expires_at <= deps.clock()
  )
    throw new ServiceError(
      "refused",
      `This Power BI connection link has expired or was used already. Connect Power BI again at ${connectionsPage(deps.config)}, then run this again.`,
    );
  if (query.code === undefined)
    throw new ServiceError(
      "refused",
      `Microsoft did not connect Power BI. Connect Power BI again at ${connectionsPage(deps.config)}, then run this again.`,
    );
  const redeemed = await redeemCode(deps, {
    code: query.code,
    code_verifier: started.code_verifier,
    redirect_uri: redirectUri(deps.config),
  });
  const strict = await deps.settings.get(
    "powerbi.connection_requires_matching_email",
  );
  if (strict) await admit(deps, person, redeemed);
  const oid = redeemed.oid;
  const values = {
    microsoft_object_id: oid,
    user_principal_name: redeemed.preferred_username,
    group_object_ids: [],
    groups_read_at: null,
    groups_attempted_at: null,
    ...(await sealTokens(deps.vault, redeemed)),
    status: "connected" as const,
    connected_at: deps.clock(),
    refreshed_at: null,
    last_used_at: null,
    last_error: null,
  };
  const ended = await deps.db.transaction(async (tx) => {
    await hidingValues(
      tx
        .insert(powerbiConnection)
        .values({ user_id: person.user_id, ...values })
        .onConflictDoUpdate({
          target: powerbiConnection.user_id,
          set: values,
        }),
    );
    await tx
      .update(personIdentity)
      .set({ groups_read_at: null })
      .where(
        and(
          eq(personIdentity.user_id, person.user_id),
          ne(personIdentity.microsoft_object_id, oid),
        ),
      );
    if (!strict) return [];
    await hidingValues(
      tx
        .insert(personIdentity)
        .values({ user_id: person.user_id, microsoft_object_id: oid })
        .onConflictDoUpdate({
          target: personIdentity.user_id,
          set: { microsoft_object_id: oid },
        }),
    );
    const others = await tx
      .select({ user_id: powerbiConnection.user_id })
      .from(powerbiConnection)
      .where(
        and(
          eq(powerbiConnection.microsoft_object_id, oid),
          eq(powerbiConnection.status, "connected"),
          ne(powerbiConnection.user_id, person.user_id),
        ),
      )
      .for("update");
    for (const other of others)
      await endConnection(tx, other.user_id, {
        status: "needs_reconnect",
        last_error: ownAccountRequired(deps.config),
      });
    return others;
  });
  for (const other of ended)
    await writeAudit(deps, {
      principal: deps.principal,
      action: "powerbi.disconnect",
      resource: { kind: "powerbi_connection", id: other.user_id },
      decision: "allow",
      reason: "account claimed by its owner under strict matching",
    });
  return started.next;
}

/**
 * Nobody attaches an account that is not theirs, and one account connects
 * to one person. A person with a Microsoft account on record (from signing
 * in with it, or an earlier connection) connects that one, however this
 * session signed in; anyone else's account must carry their verified email.
 */
async function admit(
  deps: AppDeps,
  person: BrowserPerson,
  account: RedeemedCode,
): Promise<void> {
  const refuse = (message: string) => new ServiceError("refused", message);
  const [recorded] = await deps.db
    .select({ oid: personIdentity.microsoft_object_id })
    .from(personIdentity)
    .where(eq(personIdentity.user_id, person.user_id));
  if (recorded?.oid != null) {
    if (recorded.oid !== account.oid)
      throw refuse(
        "Connect the Microsoft account you signed in with, or connected before.",
      );
  } else {
    const addresses = [account.email, account.preferred_username].map(
      (address) => address?.toLowerCase(),
    );
    if (
      !person.email_verified ||
      !addresses.includes(person.email.toLowerCase())
    )
      throw refuse(
        `Connect the Microsoft account whose email address is yours, ${person.email}.`,
      );
  }
  const elsewhere = await deps.db
    .select({ user_id: personIdentity.user_id })
    .from(personIdentity)
    .where(
      and(
        eq(personIdentity.microsoft_object_id, account.oid),
        ne(personIdentity.user_id, person.user_id),
      ),
    );
  if (elsewhere.length > 0) throw accountTaken();
}
