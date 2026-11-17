import { and, eq, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app.js";
import type { AppDeps, Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { ServiceError } from "../../errors.js";
import { peerOf } from "../../http/peer.js";
import type { Principal } from "../../principal.js";
import { type PowerbiHolder, powerbiAttributes } from "../access/visibility.js";
import { refreshStaleGroups } from "../connection/groups.js";
import { DEMO_PERSON_EMAIL } from "../demo/person.js";
import { enforceOwnAccount, lockConnection } from "../connection/store.js";
import { countRequest } from "../rate-limit.js";
import { apiConfig, type Auth } from "./better-auth.js";
import { clientAddress } from "./client-address.js";
import { CLI_CLIENT_ID } from "./grants.js";
import { resourceOfPath, verifyAccessToken } from "./oauth.js";
import {
  MICROSOFT,
  NOT_ASSIGNED,
  type Person,
  type PersonSubject,
  readIdentity,
  resolveRoles,
  roleSubject,
  SIGN_IN_FRESH_MS,
} from "./roles.js";
import {
  API_KEY_PREFIX,
  type KeyHolder,
  keyHolder,
} from "./service-accounts.js";

/** Who a browser session belongs to, beside its principal, for /api/v1/me. */
export type SignedInPerson = {
  email: string;
  name: string;
  sign_in_method: string;
  session_id: string;
};

/**
 * The attributes Cerbos reads on every principal, whatever its credential:
 * the three Power BI lists, which asCerbos refuses a principal without. A
 * person's come from their connected account, or their own account when
 * disconnected. The connected account counts while Microsoft proved it
 * within SIGN_IN_FRESH_MS, by the connect itself or a groups read, and its
 * Entra groups while they were read that recently. A service account's are
 * the workspaces and apps its admin gave it.
 */
async function principalAttributes(
  db: Db,
  holder:
    | { kind: "person"; subject: PersonSubject; user_id: string; now: Date }
    | Extract<PowerbiHolder, { kind: "service_account" }>,
): Promise<Record<string, string[]>> {
  if (holder.kind === "service_account") return powerbiAttributes(db, holder);
  const [connection] = await db
    .select({
      oid: powerbiConnection.microsoft_object_id,
      groups: powerbiConnection.group_object_ids,
      read_at: powerbiConnection.groups_read_at,
      connected_at: powerbiConnection.connected_at,
    })
    .from(powerbiConnection)
    .where(
      and(
        eq(powerbiConnection.user_id, holder.user_id),
        eq(powerbiConnection.status, "connected"),
      ),
    );
  if (connection !== undefined) {
    const since = holder.now.getTime() - SIGN_IN_FRESH_MS;
    const groupsFresh =
      connection.read_at !== null && connection.read_at.getTime() > since;
    return powerbiAttributes(db, {
      kind: "person",
      microsoft_object_id:
        groupsFresh || connection.connected_at.getTime() > since
          ? connection.oid
          : null,
      group_object_ids: groupsFresh ? connection.groups : [],
    });
  }
  return powerbiAttributes(db, {
    kind: "person",
    microsoft_object_id: holder.subject.microsoft_object_id,
    group_object_ids: holder.subject.groups.flatMap((group) =>
      group.provider === MICROSOFT ? [group.id] : [],
    ),
  });
}

/**
 * A person, however their credential reached the api, with the roles and
 * Power BI lists that reach them now: never kept in a session or a token.
 */
export async function personPrincipal(
  deps: AppDeps,
  person: Person,
  channel: Pick<Principal, "via" | "client_id">,
): Promise<Principal> {
  if (await deps.settings.get("powerbi.connection_requires_matching_email")) {
    const [connection] = await deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, person.id));
    if (
      connection?.status === "connected" &&
      (await readIdentity(deps.db, person.id))?.microsoft_object_id !==
        connection.microsoft_object_id
    )
      await deps.db.transaction(async (tx) => {
        const row = await lockConnection(tx, person.id);
        if (row?.status === "connected") await enforceOwnAccount(deps, tx, row);
      });
  }
  try {
    await refreshStaleGroups(deps, person.id);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    deps.logger.warn("reading the person's groups failed", {
      user_id: person.id,
      error: error.message,
    });
  }
  const subject = await roleSubject(deps.db, person, deps.clock());
  return {
    kind: "person",
    id: person.id,
    roles: await resolveRoles(deps, subject),
    attributes: await principalAttributes(deps.db, {
      kind: "person",
      subject,
      user_id: person.id,
      now: deps.clock(),
    }),
    via: channel.via,
    client_id: channel.client_id,
  };
}

async function serviceAccountPrincipal(
  db: Db,
  holder: KeyHolder,
): Promise<Principal> {
  return {
    kind: "service_account",
    id: holder.name,
    roles: holder.roles,
    attributes: await principalAttributes(db, {
      kind: "service_account",
      workspace_ids: holder.workspace_ids,
      app_ids: holder.app_ids,
    }),
    via: "api",
    client_id: null,
  };
}

/**
 * The service account a key names on /api/v1, within its rate limit. The
 * client address is read as sign-in reads it (see clientAddress).
 */
async function apiKeyPrincipal(
  deps: AppDeps,
  c: Context<AppEnv>,
  key: string,
): Promise<Principal | null> {
  const address = clientAddress(
    peerOf(c.env),
    c.req.raw.headers,
    apiConfig(deps.config),
  );
  const holder = await keyHolder(deps, key, address);
  if (holder === null) return null;
  // Read on every request, so a change in the admin section applies at once.
  const max = await deps.settings.get("service_accounts.rate_per_minute");
  const verdict = await countRequest(
    deps.db,
    `service_account:${holder.name}`,
    { window_seconds: 60, max },
    deps.clock(),
  );
  if (!verdict.allowed)
    throw new ServiceError(
      "rate_limited",
      `This service account made ${String(max)} requests in the last minute. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
    );
  return serviceAccountPrincipal(deps.db, holder);
}

/**
 * Sets c.var.principal from the request's credential, when it carries a
 * valid one, and nothing else: the gate, next, turns away a request with no
 * principal off the public paths. Each kind of credential has its branch
 * here: a session cookie, an OAuth access token on /api/mcp and /api/v1, and
 * an API key on /api/v1 alone, told from a token by its prefix. A request
 * that sends a bearer token is decided by the token alone. An app that
 * serves the demo reads no credential at all: http/demo.ts sets the demo
 * person, with asDemoPerson, on the requests that need one.
 */
export function authenticate(
  deps: AppDeps,
  auth: Auth,
  serveDemo: boolean,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (serveDemo) return next();
    const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "");
    const resource = resourceOfPath(c.req.path);
    if (bearer?.[1] !== undefined && resource !== null) {
      if (bearer[1].startsWith(API_KEY_PREFIX)) {
        const principal =
          resource === "v1" ? await apiKeyPrincipal(deps, c, bearer[1]) : null;
        if (principal === null) c.set("bearer_refusal", "invalid_token");
        else c.set("principal", principal);
        return next();
      }
      const verdict = await verifyAccessToken(deps, bearer[1], resource);
      if (verdict.ok) {
        c.set(
          "principal",
          await personPrincipal(deps, verdict.person, {
            via: verdict.client_id === CLI_CLIENT_ID ? "cli" : "mcp",
            client_id: verdict.client_id,
          }),
        );
        c.set("identity", { email: verdict.person.email, name: verdict.name });
      } else c.set("bearer_refusal", verdict.refusal);
      return next();
    }
    const signedIn =
      c.req.header("cookie") === undefined
        ? null
        : await auth.session(c.req.raw.headers);
    if (signedIn !== null) {
      const { user, session } = signedIn;
      c.set(
        "principal",
        await personPrincipal(
          deps,
          {
            id: user.id,
            email: user.email,
            email_verified: user.emailVerified,
          },
          { via: "browser", client_id: null },
        ),
      );
      c.set("identity", { email: user.email, name: user.name });
      c.set("person", {
        email: user.email,
        name: user.name,
        sign_in_method: session.sign_in_method,
        session_id: session.id,
      });
    }
    return next();
  };
}

/**
 * The demo's one principal, read with no cookie and no bearer token, so a
 * credential a visitor brings, an admin's session included, does nothing.
 * There is no session, so c.var.person stays unset. Until the seed has made
 * the demo person's user, nothing is set, and http/demo.ts answers 503.
 */
export async function asDemoPerson(
  deps: AppDeps,
  c: Context<AppEnv>,
): Promise<void> {
  const [found] = await deps.db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerified,
    })
    .from(user)
    .where(sql`lower(${user.email}) = ${DEMO_PERSON_EMAIL}`);
  if (found === undefined) return;
  const { name, ...person } = found;
  c.set(
    "principal",
    await personPrincipal(deps, person, { via: "browser", client_id: null }),
  );
  c.set("identity", { email: person.email, name });
}

/**
 * Each route checks its own credential, whatever ran before it. A person no
 * role reaches any more is refused, as their next sign-in would be.
 */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (principal === undefined)
    throw new ServiceError("unauthenticated", "Sign in first.");
  if (principal.roles.length === 0)
    throw new ServiceError("refused", NOT_ASSIGNED);
  return principal;
}

/**
 * For a person's own grants and Power BI connection, kept by user id: a
 * service account has neither, and its name must never pass for a user id.
 */
export function requirePerson(c: Context<AppEnv>): Principal {
  const principal = requirePrincipal(c);
  if (principal.kind !== "person")
    throw new ServiceError(
      "refused",
      "Only a person has connections; a service account has none.",
    );
  return principal;
}
