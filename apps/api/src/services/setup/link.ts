import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { parse } from "hono/utils/cookie";
import { z } from "zod";
import type { AppDeps, Db, ServiceContext } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { setting } from "../../db/schema/settings.js";
import { setupLink } from "../../db/schema/setup.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { assignRole, hasAdmin } from "../admin/people.js";
import { setSetting } from "../admin/settings.js";
import { onTheMock, signInSetupFinished } from "../auth/sign-in-config.js";
import type { SignInClaims } from "../auth/sign-in.js";
import { inTransaction } from "../settings/store.js";
import { bindTenant } from "./bound.js";
import { devSignInOffTheMock } from "./tenant.js";

/*
 * The first-run door (threat model B9). While no admin exists, a link from
 * `server setup-link` opens one setup session for 12 hours, and that session may
 * start one Microsoft sign-in, which sign-in admits whatever the roles say,
 * for the OAuth flow the session's own browser started. Once an admin
 * exists every row goes, and every part of it is refused.
 */

const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;

/** The setup API, and the path of the setup session's cookie. */
export const SETUP_PATH = "/api/setup";
export const SETUP_COOKIE = "__Secure-pbmb_setup";
/** The setup sign-in's marker, sent to Better Auth's paths only: the sign-in's start and Microsoft's callback. */
export const SETUP_SIGN_IN_COOKIE = "__Secure-pbmb_setup_sign_in";
export const SETUP_SIGN_IN_COOKIE_PATH = "/api/auth";
const SIGN_IN_START = "/api/auth/sign-in/social";
const SIGN_IN_CALLBACK = "/api/auth/callback/microsoft";

type Deps = Pick<AppDeps, "db" | "clock">;
export type SetupSession = typeof setupLink.$inferSelect;
/** What a request to Better Auth carries of the setup's sign-in: the marker, and on the callback its state. */
export type SetupSignIn = { marker: string; state: string | null };

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const fresh = () => randomBytes(32).toString("base64url");

/** Whether an admin exists; once one does, every link and setup session is deleted. */
export async function adminExists(db: Db): Promise<boolean> {
  if (!(await hasAdmin(db))) return false;
  await db.delete(setupLink);
  return true;
}

/**
 * At start, with no admin yet, says that a link can be printed and how. The
 * log holds no link and no token: whoever can read a hosted platform's log
 * must not be able to open the setup first.
 */
export async function announceSetupLink(
  deps: Pick<AppDeps, "db" | "logger">,
): Promise<void> {
  if (await adminExists(deps.db)) return;
  deps.logger.warn(
    "no admin yet: print the one-time setup link with `server setup-link` (in a container: docker compose exec api server setup-link)",
  );
}

/**
 * A new link, single use, for 24 hours, on the SPA's page with the token in
 * the fragment, which no request carries; null once an admin exists.
 * `server setup-link` revokes every earlier link and session. With
 * `revoke_earlier` false every link nobody spent goes, and an open session
 * stays, so a restart mid-setup keeps its holder in.
 */
export async function newSetupLink(
  deps: Deps & Pick<AppDeps, "config">,
  options: { revoke_earlier: boolean },
): Promise<string | null> {
  if (await adminExists(deps.db)) return null;
  const now = deps.clock();
  await deps.db
    .delete(setupLink)
    .where(
      options.revoke_earlier
        ? undefined
        : or(
            isNull(setupLink.session_digest),
            lte(setupLink.session_expires_at, now),
          ),
    );
  const token = fresh();
  await deps.db.insert(setupLink).values({
    token_digest: digest(token),
    expires_at: new Date(now.getTime() + LINK_LIFETIME_MS),
  });
  const url = new URL("/setup", deps.config.public_base_url);
  url.hash = `token=${token}`;
  return url.href;
}

/** Spends the link's token and answers the session's cookie value; null for a used, expired or unknown token, or once an admin exists. */
export async function openSetupSession(
  deps: Deps,
  token: string,
): Promise<string | null> {
  if (await adminExists(deps.db)) return null;
  const session = fresh();
  const now = deps.clock();
  const opened = await deps.db
    .update(setupLink)
    .set({
      session_digest: digest(session),
      session_expires_at: new Date(now.getTime() + SESSION_LIFETIME_MS),
    })
    .where(
      and(
        eq(setupLink.token_digest, digest(token)),
        isNull(setupLink.session_digest),
        gt(setupLink.expires_at, now),
      ),
    )
    .returning({ token_digest: setupLink.token_digest });
  return opened.length === 0 ? null : session;
}

/** The setup session the cookie names, within its 12 hours and while no admin exists. */
export async function setupSession(
  deps: Deps,
  cookie: string | undefined,
): Promise<SetupSession | null> {
  if (cookie === undefined || (await adminExists(deps.db))) return null;
  const [row] = await deps.db
    .select()
    .from(setupLink)
    .where(
      and(
        eq(setupLink.session_digest, digest(cookie)),
        gt(setupLink.session_expires_at, deps.clock()),
      ),
    );
  return row ?? null;
}

/** The marker of the session's one Microsoft sign-in, in place of any earlier one, for 10 minutes. */
export async function startSetupSignIn(
  deps: Deps,
  session: SetupSession,
): Promise<string> {
  const marker = fresh();
  await deps.db
    .update(setupLink)
    .set({
      sign_in_digest: digest(marker),
      sign_in_expires_at: new Date(
        deps.clock().getTime() + SIGN_IN_LIFETIME_MS,
      ),
      sign_in_state_digest: null,
    })
    .where(eq(setupLink.token_digest, session.token_digest));
  return marker;
}

/** The setup's sign-in a request to Better Auth carries: on the sign-in's start, and on Microsoft's callback with its state. */
export function setupSignInOf(request: Request): SetupSignIn | null {
  const url = new URL(request.url);
  if (url.pathname !== SIGN_IN_START && url.pathname !== SIGN_IN_CALLBACK)
    return null;
  const header = request.headers.get("cookie");
  const marker =
    header === null
      ? undefined
      : parse(header, SETUP_SIGN_IN_COOKIE)[SETUP_SIGN_IN_COOKIE];
  if (marker === undefined) return null;
  const state =
    url.pathname === SIGN_IN_CALLBACK ? url.searchParams.get("state") : null;
  return { marker, state };
}

const live = (marker: string, now: Date) =>
  and(
    eq(setupLink.sign_in_digest, digest(marker)),
    gt(setupLink.sign_in_expires_at, now),
    isNotNull(setupLink.session_digest),
    gt(setupLink.session_expires_at, now),
  );

/** A live marker and the state of the flow its holder started: only that callback is the setup's. */
const markerWhere = (signIn: SetupSignIn | null, now: Date) =>
  signIn === null || signIn.state === null
    ? undefined
    : and(
        live(signIn.marker, now),
        eq(setupLink.sign_in_state_digest, digest(signIn.state)),
      );

/** Better Auth's answer to a sign-in's start: the provider's authorize URL. */
const startedAt = z.object({ url: z.url() });

/**
 * After Better Auth's answer: the start of the holder's sign-in binds the
 * marker to the state it sent to Microsoft, and the callback expires the
 * marker's cookie, spent or refused.
 */
export async function followSetupSignIn(
  deps: Deps,
  signIn: SetupSignIn | null,
  response: Response,
): Promise<Response> {
  if (signIn === null) return response;
  if (signIn.state !== null) {
    const answer = new Response(response.body, response);
    answer.headers.append(
      "set-cookie",
      `${SETUP_SIGN_IN_COOKIE}=; Max-Age=0; Path=${SETUP_SIGN_IN_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`,
    );
    return answer;
  }
  const started = startedAt.safeParse(
    response.ok
      ? await response
          .clone()
          .json()
          .then(
            (body: unknown) => body,
            () => null,
          )
      : null,
  );
  const state = started.success
    ? new URL(started.data.url).searchParams.get("state")
    : null;
  if (state !== null)
    await deps.db
      .update(setupLink)
      .set({ sign_in_state_digest: digest(state) })
      .where(live(signIn.marker, deps.clock()));
  return response;
}

/** Whether this Microsoft callback is the setup's, so sign-in admits it before an account exists. */
export async function setupSignInOpen(
  deps: Deps,
  signIn: SetupSignIn | null,
): Promise<boolean> {
  const where = markerWhere(signIn, deps.clock());
  if (where === undefined || (await adminExists(deps.db))) return false;
  const rows = await deps.db
    .select({ token_digest: setupLink.token_digest })
    .from(setupLink)
    .where(where);
  return rows.length > 0;
}

/**
 * Spends the marker on the person the callback made: true when it was this
 * callback's to spend. The tenant id and the side of the mock the token was
 * checked against are kept with it: they are what the first admin binds.
 */
export async function spendSetupSignIn(
  deps: Deps,
  signIn: SetupSignIn | null,
  userId: string,
  claims: SignInClaims,
): Promise<boolean> {
  const where = markerWhere(signIn, deps.clock());
  if (where === undefined || (await adminExists(deps.db))) return false;
  const spent = await deps.db
    .update(setupLink)
    .set({
      sign_in_digest: null,
      sign_in_expires_at: null,
      sign_in_state_digest: null,
      admitted_user_id: userId,
      signed_in_tenant_id: claims.checked_tenant_id,
      signed_in_sample: claims.checked_on_mock,
    })
    .where(where)
    .returning({ token_digest: setupLink.token_digest });
  return spent.length > 0;
}

/** Whom the setup session acts as: the admin to be, with the admin's rights over the address, app registration and scanner steps, as whoever reads the log could take them anyway. */
export function setupPrincipal(session: SetupSession): Principal {
  return {
    kind: "person",
    id: session.admitted_user_id ?? "setup_link",
    roles: ["admin"],
    attributes: {
      powerbi_workspace_ids: [],
      powerbi_app_ids: [],
      powerbi_dataset_ids: [],
    },
    via: "browser",
    client_id: null,
  };
}

const describeSide = (tenant_id: string | null, sample: boolean | null) =>
  tenant_id === null || sample === null
    ? "no tenant id"
    : `tenant ${tenant_id} on ${sample ? "the mock" : "Microsoft"}`;

const changed = (
  tenant: string | null,
  sample: boolean | null,
  now_tenant: string | null,
  now_sample: boolean | null,
) =>
  `The setup's sign-in came through ${describeSide(tenant, sample)}, and the stack now has ${describeSide(now_tenant, now_sample)}. Print a new setup link and sign in again.`;

export type FirstAdmin =
  { confirm: { email: string; name: string } } | { made: true };

/**
 * The browser holding the session is signed in as the person its sign-in
 * made. Unconfirmed, it answers whom to confirm; confirmed with that
 * person's email, the person becomes the first admin, through the admin
 * services and their audit, and every link and session ends. The admin, the
 * binding of the tenant the setup's sign-in came through, the default role
 * of none unless one is stored or set by the environment, and the end of the
 * links happen in one transaction: all or none. Null for anyone else.
 */
export async function firstAdmin(
  context: ServiceContext,
  session: SetupSession,
  signedIn: string | null,
  confirmed: string | undefined,
): Promise<FirstAdmin | null> {
  if (
    session.admitted_user_id === null ||
    signedIn !== session.admitted_user_id
  )
    return null;
  const [person] = await context.db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, signedIn));
  if (person === undefined) return null;
  if (confirmed === undefined) return { confirm: person };
  if (confirmed.toLowerCase() !== person.email.toLowerCase())
    throw new ServiceError(
      "invalid",
      "That is not the email of the person who signed in. Confirm the email the setup shows.",
    );
  const [tenant_id, authority] = await Promise.all([
    context.settings.get("powerbi.tenant_id"),
    context.settings.get("powerbi.authority"),
  ]);
  const now = {
    tenant_id: tenant_id?.toLowerCase() ?? null,
    sample: onTheMock(authority),
  };
  const { signed_in_tenant_id: tenant, signed_in_sample: sample } = session;
  if (
    tenant === null ||
    sample === null ||
    tenant !== now.tenant_id ||
    sample !== now.sample
  )
    throw new ServiceError(
      "invalid",
      changed(tenant, sample, now.tenant_id, now.sample),
    );
  const dev = devSignInOffTheMock(context.config, authority);
  if (dev !== null) throw new ServiceError("invalid", dev);
  const assignment = {
    role: "admin",
    subject_kind: "person",
    subject: person.email,
  } as const;
  await context.db.transaction(async (tx) => {
    // The row is locked, so a save that commits between the compare above
    // and the bind below cannot be missed. The value compared is the one the
    // stack uses, which an environment variable can set over the row.
    await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, "powerbi.tenant_id"))
      .for("update");
    const current =
      (
        await inTransaction(context.settings, tx).get("powerbi.tenant_id")
      )?.toLowerCase() ?? null;
    if (current !== tenant)
      throw new ServiceError(
        "invalid",
        changed(tenant, sample, current, now.sample),
      );
    await bindTenant(tx, { tenant_id: tenant, sample });
    const inTx = {
      ...context,
      db: tx,
      settings: inTransaction(context.settings, tx),
    };
    if ((await inTx.settings.source("access.default_role")) === "default")
      await setSetting(inTx, "access.default_role", "none", {
        save_failing: false,
      });
    await tx.delete(setupLink);
    await assignRole(inTx, assignment, { first_admin: true });
  });
  signInSetupFinished(context.db);
  return { made: true };
}
