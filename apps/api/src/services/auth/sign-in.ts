import { AsyncLocalStorage } from "node:async_hooks";
import type { ValidateUserInfoSource } from "better-auth";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { eq, max } from "drizzle-orm";
import type { AppDeps, Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personSignIn } from "../../db/schema/roles.js";
import {
  type SetupSignIn,
  setupSignInOpen,
  spendSetupSignIn,
} from "../setup/link.js";
import { acceptOpenInvite, auditInviteAccepted } from "./accept-invite.js";
import {
  DEV_SIGN_IN_METHOD,
  devMadeAccount,
  devSignInOpen,
} from "./dev-sign-in.js";
import {
  isDeactivated,
  MICROSOFT,
  NOT_ASSIGNED,
  type Person,
  resolveRoles,
  roleSubject,
  SIGN_IN_FRESH_MS,
} from "./roles.js";
import { onTheMock } from "./sign-in-config.js";

/*
 * Who may sign in. Better Auth asks admitAtSignIn before it makes or links
 * an account, with the provider's fresh token, and admitSession whenever it
 * makes a session, whatever made it.
 */

/** What the person's sign-in token said, carried from admitAtSignIn to admitSession in the same request. */
export type SignInClaims = {
  /** The provider: `microsoft`, a provider's id from sign_in.providers, or `dev`. */
  provider: string;
  microsoft_object_id: string | null;
  /** The email a Microsoft token vouches for (microsoftEmail), in lower case; absent when it vouches for none. */
  microsoft_email?: string;
  tenant_member: boolean;
  /** null: the token named no usable groups, so the stored ones stand. */
  group_ids: string[] | null;
  /** The token vouched for the email's domain as an organisation's. */
  domain_verified: boolean;
  /** The tenant id the token was checked against, in lower case; null for a token that is no Microsoft tenant's. */
  checked_tenant_id: string | null;
  /** Whether the authority the token was checked against is the mock's. */
  checked_on_mock: boolean;
};

/** What a Microsoft token must say about itself, from the settings. */
export type Expected = {
  tenant_id: string | null;
  app_client_id: string | null;
  authority: string;
  /** The id of the Google provider in sign_in.providers, if one is on. */
  google_id: string | null;
};

type Refusal = { error: string; errorDescription: string };

/** The request's sign-in under way. createAuth's handler runs each request inside it. */
export const signingIn = new AsyncLocalStorage<{
  claims: SignInClaims | null;
  /** The setup's sign-in marker the request carried (services/setup/link.ts). */
  setup_sign_in: SetupSignIn | null;
}>();

/** Sessions made without a provider's token, by the path that made them. */
const SESSION_METHODS: Record<string, string> = {
  "/passkey/verify-authentication": "passkey",
  "/dev/sign-in": DEV_SIGN_IN_METHOD,
  "/sign-in/email": "credential",
  "/change-password": "credential",
  "/invites/accept": "credential",
};

export const DEV_MADE_ACCOUNT =
  "This Microsoft account was made by the dev sign-in, which is off. An admin must remove it before it signs in.";

export const DEACTIVATED =
  "An admin has deactivated your account. Ask an admin to reactivate it.";

export const PASSKEY_STALE =
  "Your passkey works for 7 days after you last signed in with your company account. Sign in with it once more.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An unchecked mail attribute never chooses the identity used for admission. */
export function microsoftEmail(
  profile: Record<string, unknown>,
): string | undefined {
  return z
    .email()
    .safeParse(
      profile.xms_edov === true && profile.email !== undefined
        ? profile.email
        : profile.preferred_username,
    ).data;
}

/**
 * A Microsoft ID token is accepted only when it says it comes from the
 * configured tenant's issuer, for this app, about a person in that tenant.
 * Sign-in reads it from the token endpoint's answer, unverified, so these
 * claims are its only check.
 */
export function microsoftClaims(
  profile: Record<string, unknown>,
  expected: Expected,
): SignInClaims | null {
  const authority = expected.authority.replace(/\/+$/, "");
  const { tenant_id, app_client_id } = expected;
  if (
    tenant_id === null ||
    app_client_id === null ||
    profile.iss !== `${authority}/${tenant_id}/v2.0` ||
    profile.aud !== app_client_id ||
    profile.tid !== tenant_id ||
    typeof profile.oid !== "string" ||
    profile.oid === ""
  )
    return null;
  return {
    provider: MICROSOFT,
    microsoft_object_id: profile.oid,
    microsoft_email: microsoftEmail(profile)?.toLowerCase(),
    tenant_member: true,
    group_ids: entraGroups(profile),
    domain_verified: microsoftEmail(profile) !== undefined,
    checked_tenant_id: tenant_id.toLowerCase(),
    checked_on_mock: onTheMock(authority),
  };
}

/**
 * Only these ways of signing in are known; any other is refused. `email` is
 * the address the provider gave, with whether it called it verified.
 */
export function claimsOf(
  source: ValidateUserInfoSource,
  expected: Expected,
  email: { address: string; verified: boolean },
): { claims: SignInClaims } | Refusal {
  if (source.method === "oauth" && source.oauth?.providerId === MICROSOFT) {
    const claims = microsoftClaims(source.oauth.profile ?? {}, expected);
    return claims === null
      ? {
          error: "not_in_tenant",
          errorDescription:
            "This Microsoft account is not in the company's Power BI tenant.",
        }
      : { claims };
  }
  const domain = email.address.slice(email.address.lastIndexOf("@") + 1);
  // A Google account vouches for its domain only as a Workspace account of it.
  const other =
    source.method === "oauth" &&
    source.oauth?.providerId === "google" &&
    expected.google_id !== null
      ? {
          provider: expected.google_id,
          profile: source.oauth.profile,
          domain_verified:
            email.verified &&
            String(source.oauth.profile?.hd).toLowerCase() ===
              domain.toLowerCase(),
        }
      : source.method === "sso-oidc" && source.sso !== undefined
        ? {
            provider: source.sso.providerId,
            profile: source.sso.profile,
            domain_verified: email.verified,
          }
        : source.method === DEV_SIGN_IN_METHOD
          ? {
              provider: DEV_SIGN_IN_METHOD,
              profile: undefined,
              domain_verified: true,
            }
          : null;
  if (other === null)
    return {
      error: "unknown_sign_in",
      errorDescription: "This way of signing in is not turned on.",
    };
  // Another provider's token never makes anyone a member of the Power BI tenant.
  return {
    claims: {
      provider: other.provider,
      microsoft_object_id: null,
      tenant_member: false,
      group_ids: groupsClaim(other.profile),
      domain_verified: other.domain_verified,
      checked_tenant_id: null,
      checked_on_mock: false,
    },
  };
}

/**
 * Entra's groups claim: object ids. When the person is in too many groups
 * Entra leaves them out and says so (_claim_names, hasgroups); the Power BI
 * connection then reads them through Graph.
 */
function entraGroups(profile: Record<string, unknown>): string[] | null {
  const names = profile._claim_names;
  const overflowed =
    profile.hasgroups === true ||
    (typeof names === "object" && names !== null && "groups" in names);
  const groups = groupsClaim(profile);
  return overflowed || groups === null
    ? null
    : groups.filter((id) => UUID.test(id));
}

function groupsClaim(
  profile: Record<string, unknown> | undefined,
): string[] | null {
  const groups = profile?.groups;
  return Array.isArray(groups)
    ? groups.filter((g): g is string => typeof g === "string")
    : null;
}

/** Better Auth's validateUserInfo: before an account is made or linked, and on a provider's returning sign-in. */
export async function admitAtSignIn(
  deps: AppDeps,
  expected: Expected,
  data: { user: Record<string, unknown>; source: ValidateUserInfoSource },
): Promise<Refusal | undefined> {
  const person = {
    id: typeof data.user.id === "string" ? data.user.id : null,
    email: String(data.user.email),
    email_verified: data.user.emailVerified === true,
  };
  const read = claimsOf(data.source, expected, {
    address: person.email,
    verified: person.email_verified,
  });
  if (!("claims" in read)) return read;
  // A returning person is matched as stored, which is what later requests see.
  const checked =
    person.id === null
      ? { person, claims: read.claims }
      : vouchedFor(await personById(deps.db, person.id), read.claims);
  const store = signingIn.getStore();
  if (store !== undefined) store.claims = checked.claims;
  const subject = await roleSubject(
    deps.db,
    checked.person,
    deps.clock(),
    checked.claims,
  );
  // Before the setup's sign-in: it never admits a deactivated person.
  if (subject.deactivated)
    return { error: "deactivated", errorDescription: DEACTIVATED };
  if (
    (await resolveRoles(deps, subject)).length === 0 &&
    !(
      checked.claims.provider === MICROSOFT &&
      (await setupSignInOpen(deps, store?.setup_sign_in ?? null))
    )
  )
    return { error: "not_assigned", errorDescription: NOT_ASSIGNED };
  return undefined;
}

/**
 * A Microsoft sign-in vouches for the stored email only when its token's
 * email is that one: an account made before xms_edov counted can hold a
 * `mail` address nobody checked. Otherwise the email is unverified and the
 * sign-in vouches for no domain.
 */
function vouchedFor(
  stored: Person,
  claims: SignInClaims,
): { person: Person; claims: SignInClaims } {
  return claims.provider !== MICROSOFT ||
    stored.email.toLowerCase() === claims.microsoft_email
    ? { person: stored, claims }
    : {
        person: { ...stored, email_verified: false },
        claims: { ...claims, domain_verified: false },
      };
}

/**
 * Better Auth's session.create.before: refuses a deactivated person, records
 * the sign-in, refuses a passkey when the person's last provider sign-in is
 * stale, accepts the person's open invite, and refuses a person no role
 * reaches now. Returns the session's sign-in method; sessionEnd says when a
 * passkey's session ends.
 */
export async function admitSession(
  deps: AppDeps,
  userId: string,
  path: string | null,
): Promise<string> {
  const store = signingIn.getStore();
  const claims = store?.claims ?? null;
  const method =
    claims?.provider ?? (path === null ? undefined : SESSION_METHODS[path]);
  if (method === undefined)
    throw new APIError("FORBIDDEN", {
      code: "unknown_sign_in",
      message: "This way of signing in is not turned on.",
    });
  // A Microsoft account the dev sign-in made signs nobody in once it is shut:
  // the database may have changed since start (refuseDevSignInResidue).
  const objectId = claims?.microsoft_object_id ?? null;
  if (
    method === MICROSOFT &&
    objectId !== null &&
    !devSignInOpen(deps.config) &&
    (await devMadeAccount(deps.db, objectId))
  )
    throw new APIError("FORBIDDEN", {
      code: "dev_sign_in_account",
      message: DEV_MADE_ACCOUNT,
    });
  // Before the sign-in is recorded and the setup's marker is spent.
  if (await isDeactivated(deps.db, userId))
    throw new APIError("FORBIDDEN", {
      code: "deactivated",
      message: DEACTIVATED,
    });
  const now = deps.clock();
  // Later requests read emailVerified, so it keeps what this sign-in vouched for.
  if (method === MICROSOFT && claims !== null) {
    const stored = await personById(deps.db, userId);
    const vouched = vouchedFor({ ...stored, email_verified: true }, claims)
      .person.email_verified;
    if (stored.email_verified !== vouched)
      await deps.db
        .update(user)
        .set({ emailVerified: vouched })
        .where(eq(user.id, userId));
  }
  if (method === "passkey") {
    const last = await lastSignedIn(deps.db, userId);
    if (last === null || last.getTime() <= now.getTime() - SIGN_IN_FRESH_MS)
      throw new APIError("FORBIDDEN", {
        code: "sign_in_again",
        message: PASSKEY_STALE,
      });
  } else {
    // The dev sign-in, when it makes no account, carries no claims; it stands in for a provider.
    await recordSignIn(deps.db, userId, method, now, {
      group_ids: claims?.group_ids ?? null,
      domain_verified: claims?.domain_verified ?? method === DEV_SIGN_IN_METHOD,
    });
    if (claims?.microsoft_object_id != null)
      await recordMicrosoftIdentity(deps.db, userId, claims, now);
  }
  // The setup's one Microsoft sign-in, while no admin exists, whoever the
  // roles reach: its marker is spent here on the person it made.
  const setup =
    method === MICROSOFT &&
    claims !== null &&
    (await spendSetupSignIn(
      deps,
      store?.setup_sign_in ?? null,
      userId,
      claims,
    ));
  const person = await personById(deps.db, userId);
  const accepted = await acceptOpenInvite(deps.db, person, now);
  const roles = await resolveRoles(
    deps,
    await roleSubject(deps.db, person, now),
  );
  if (accepted) await auditInviteAccepted(deps, person, roles);
  if (roles.length === 0 && !setup)
    throw new APIError("FORBIDDEN", {
      code: "not_assigned",
      message: NOT_ASSIGNED,
    });
  return method;
}

/** The person's latest sign-in with a provider or a password; a passkey's is never recorded. */
async function lastSignedIn(db: Db, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(personSignIn.signed_in_at) })
    .from(personSignIn)
    .where(eq(personSignIn.user_id, userId));
  return row?.at ?? null;
}

/**
 * When a session ends: Better Auth's `end`, and for a passkey's no later
 * than the sign-in behind it stops counting, so a passkey never carries a
 * session past that sign-in's SIGN_IN_FRESH_MS.
 */
export async function sessionEnd(
  db: Db,
  userId: string,
  method: string,
  end: Date,
): Promise<Date> {
  if (method !== "passkey") return end;
  const last = await lastSignedIn(db, userId);
  if (last === null)
    throw new Error("a passkey session was admitted with no sign-in behind it");
  return new Date(Math.min(end.getTime(), last.getTime() + SIGN_IN_FRESH_MS));
}

async function recordSignIn(
  db: Db,
  userId: string,
  provider: string,
  now: Date,
  token: { group_ids: string[] | null; domain_verified: boolean },
): Promise<void> {
  const values = { signed_in_at: now, ...token };
  await db
    .insert(personSignIn)
    .values({ user_id: userId, provider, ...values })
    .onConflictDoUpdate({
      target: [personSignIn.user_id, personSignIn.provider],
      set: values,
    });
}

/** The Microsoft account a person signed in with, and their groups when the token named them. */
async function recordMicrosoftIdentity(
  db: Db,
  userId: string,
  claims: SignInClaims,
  now: Date,
): Promise<void> {
  const oid = claims.microsoft_object_id;
  if (oid === null) return;
  const groups =
    claims.group_ids === null
      ? {}
      : { group_object_ids: claims.group_ids, groups_read_at: now };
  await db
    .insert(personIdentity)
    .values({ user_id: userId, microsoft_object_id: oid, ...groups })
    .onConflictDoUpdate({
      target: personIdentity.user_id,
      set: { microsoft_object_id: oid, ...groups },
    });
}

export async function personById(db: Db, userId: string): Promise<Person> {
  const [row] = await db
    .select({ id: user.id, email: user.email, verified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  if (row === undefined)
    throw new Error("a session was made for a user that does not exist");
  return { id: row.id, email: row.email, email_verified: row.verified };
}
