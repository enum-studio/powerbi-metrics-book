import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import type { Db, SettingValue } from "../../context.js";
import { invite, openInvite } from "../../db/schema/invites.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personDeactivation } from "../../db/schema/people.js";
import { personSignIn, roleAssignment } from "../../db/schema/roles.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { anyOf } from "../access/plan.js";

/** The provider id of Entra groups, in role assignments and sign-ins. */
export const MICROSOFT = "microsoft";

/** Groups from a sign-in count this long after it, and a passkey signs in only within it. */
export const SIGN_IN_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** A group id as one provider names it: the same id at another provider is another group. */
export type Group = { provider: string; id: string };

/** What role assignments are matched against. */
export type RoleSubject = {
  email: string;
  /** Only a verified email is matched against person and email domain assignments. */
  email_verified: boolean;
  /**
   * A recent sign-in vouched for the email's domain as an organisation's:
   * Microsoft's tenant, an OpenID Connect provider's verified email, or a
   * Google Workspace token whose `hd` is that domain.
   */
  domain_verified: boolean;
  groups: readonly Group[];
  /** Signed in with, or connected, a Microsoft account in the Power BI tenant, within SIGN_IN_FRESH_MS. */
  tenant_member: boolean;
  /** An admin deactivated the person: no role reaches them. */
  deactivated: boolean;
  /** The role of the open, unexpired invite to the verified email, which reaches the person as a person assignment would. */
  open_invite_role: string | null;
};

/** Whom a person is now: their role subject, and the Microsoft account visibility matches. */
export type PersonSubject = RoleSubject & {
  /** As fresh as tenant_member's evidence; null past it, or with no Microsoft account on record. */
  microsoft_object_id: string | null;
};

/** A signed-in person, as the user table holds them. */
export type Person = { id: string; email: string; email_verified: boolean };

/** What the token of a sign-in under way says, before it is stored. */
export type SigningIn = {
  provider: string;
  group_ids: string[] | null;
  domain_verified: boolean;
  tenant_member: boolean;
};

export type Assignment =
  | { role: string; subject_kind: "person" | "email_domain"; subject: string }
  | { role: string; subject_kind: "group"; provider: string; subject: string }
  | { role: string; subject_kind: "everyone_in_tenant" };

export type RoleAssignment = typeof roleAssignment.$inferSelect;

/** Shown on the sign-in page to a person no role reaches. */
export const NOT_ASSIGNED =
  "Nobody has given you access to this Power BI Metrics Book yet. Ask one of its admins to add you.";

/** Where resolveRoles finds the default role: the settings, or the value a caller read before a lock. */
type DefaultRole = {
  get(key: "access.default_role"): Promise<SettingValue<"access.default_role">>;
};

/**
 * The roles that reach a person now, none for a deactivated person: by
 * verified email or an open invite to it, by the domain of a
 * verified email when a sign-in vouched for that domain, by group within
 * the provider that named it, and for
 * everyone in the tenant. A tenant member no assignment reaches gets
 * `access.default_role`, unless it is `none`.
 */
export async function resolveRoles(
  deps: { db: Db; settings: DefaultRole },
  who: RoleSubject,
): Promise<string[]> {
  if (who.deactivated) return [];
  const t = roleAssignment;
  const reaches: (SQL | undefined)[] = [];
  if (who.email_verified) {
    const email = who.email.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    reaches.push(and(eq(t.subject_kind, "person"), eq(t.subject, email)));
    if (who.domain_verified)
      reaches.push(
        and(eq(t.subject_kind, "email_domain"), eq(t.subject, domain)),
      );
  }
  for (const [provider, ids] of byProvider(who.groups))
    reaches.push(
      and(
        eq(t.subject_kind, "group"),
        eq(t.provider, provider),
        anyOf(t.subject, ids),
      ),
    );
  if (who.tenant_member) reaches.push(eq(t.subject_kind, "everyone_in_tenant"));
  // An empty or() would match every row.
  const rows =
    reaches.length === 0
      ? []
      : await deps.db
          .selectDistinct({ role: t.role })
          .from(t)
          .where(or(...reaches))
          .orderBy(asc(t.role));
  const roles = rows.map((r) => r.role);
  const invited = who.open_invite_role;
  if (invited !== null && !roles.includes(invited)) {
    roles.push(invited);
    roles.sort();
  }
  if (roles.length > 0 || !who.tenant_member) return roles;
  const fallback = await deps.settings.get("access.default_role");
  return fallback === "none" ? [] : [fallback];
}

/**
 * Every request of a person runs this, on the api's one event loop, so it
 * pushes rather than copies the list for each id: copying made 70,000 groups
 * about 2.45 billion writes, and stopped the loop for 7.5 seconds or more.
 */
const named = (provider: string, ids: readonly string[] | null): Group[] =>
  (ids ?? []).map((id) => ({ provider, id }));

function byProvider(groups: readonly Group[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { provider, id } of groups) {
    const ids = found.get(provider);
    if (ids === undefined) found.set(provider, [id]);
    else ids.push(id);
  }
  return found;
}

/**
 * Whom a person is for resolveRoles now: their Entra groups and tenant
 * membership from person_identity, and the groups and vouched domain of
 * their sign-ins, each only within SIGN_IN_FRESH_MS of being read. `signingIn`
 * overlays the token of a sign-in that is not stored yet; `person.id` is
 * null for someone who has no account yet.
 */
export async function roleSubject(
  db: Db,
  person: { id: string | null; email: string; email_verified: boolean },
  now: Date,
  signingIn?: SigningIn,
): Promise<PersonSubject> {
  const since = new Date(now.getTime() - SIGN_IN_FRESH_MS);
  const identity =
    person.id === null ? null : await readIdentity(db, person.id);
  const deactivated =
    person.id !== null && (await isDeactivated(db, person.id));
  const [invited] = person.email_verified
    ? await db
        .select({ role: invite.role })
        .from(invite)
        .where(
          and(
            eq(invite.email, person.email.toLowerCase()),
            openInvite,
            gt(invite.expires_at, now),
          ),
        )
    : [];
  const signIns =
    person.id === null
      ? []
      : await db
          .select()
          .from(personSignIn)
          .where(
            and(
              eq(personSignIn.user_id, person.id),
              gt(personSignIn.signed_in_at, since),
            ),
          );
  const entra =
    signingIn?.provider === MICROSOFT && signingIn.group_ids !== null
      ? signingIn.group_ids
      : identity?.groups_read_at != null && identity.groups_read_at > since
        ? identity.group_object_ids
        : [];
  const groups = [
    ...named(MICROSOFT, entra),
    // Entra's groups come from person_identity, which the connection keeps current.
    ...signIns
      .filter(
        (row) =>
          row.provider !== MICROSOFT && row.provider !== signingIn?.provider,
      )
      .flatMap((row) => named(row.provider, row.group_ids)),
    ...(signingIn === undefined || signingIn.provider === MICROSOFT
      ? []
      : named(signingIn.provider, signingIn.group_ids)),
  ];
  // The Microsoft account, and with it membership, is as fresh as its
  // evidence: a Microsoft sign-in, or the groups a connection read, within
  // SIGN_IN_FRESH_MS. An ended connection clears groups_read_at.
  const microsoftSignIn = signIns.some((row) => row.provider === MICROSOFT);
  const microsoft_object_id =
    microsoftSignIn ||
    (identity?.groups_read_at != null && identity.groups_read_at > since)
      ? (identity?.microsoft_object_id ?? null)
      : null;
  return {
    email: person.email,
    email_verified: person.email_verified,
    domain_verified:
      signingIn?.domain_verified === true ||
      signIns.some((row) => row.domain_verified),
    groups,
    tenant_member:
      signingIn?.tenant_member === true ||
      microsoftSignIn ||
      microsoft_object_id !== null,
    deactivated,
    open_invite_role: invited?.role ?? null,
    microsoft_object_id,
  };
}

/**
 * Everything on record for a person, however old: the groups of their latest
 * connection read and of their latest sign-in through each provider, their
 * email's domain, and the tenant if a Microsoft account of theirs is on record. Not whom they are now (roleSubject), but whom an
 * assignment would reach once their evidence is fresh again, as by
 * reconnecting Power BI or signing in.
 */
export async function subjectOnRecord(
  db: Db,
  person: Person,
): Promise<RoleSubject> {
  const identity = await readIdentity(db, person.id);
  const signIns = await db
    .select({
      provider: personSignIn.provider,
      group_ids: personSignIn.group_ids,
    })
    .from(personSignIn)
    .where(eq(personSignIn.user_id, person.id));
  return {
    email: person.email,
    email_verified: true,
    domain_verified: true,
    groups: [
      ...named(MICROSOFT, identity?.group_object_ids ?? null),
      ...signIns.flatMap((row) => named(row.provider, row.group_ids)),
    ],
    tenant_member:
      identity?.microsoft_object_id != null ||
      signIns.some((row) => row.provider === MICROSOFT),
    deactivated: false,
    open_invite_role: null,
  };
}

export async function isDeactivated(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: personDeactivation.user_id })
    .from(personDeactivation)
    .where(eq(personDeactivation.user_id, userId));
  return rows.length > 0;
}

export async function readIdentity(
  db: Db,
  userId: string,
): Promise<typeof personIdentity.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(personIdentity)
    .where(eq(personIdentity.user_id, userId));
  return row ?? null;
}

/** Emails and domains are kept in lower case, as resolveRoles compares them. */
export async function assignRole(
  db: Db,
  assignment: Assignment,
  by: Pick<Principal, "id">,
): Promise<RoleAssignment> {
  const values =
    assignment.subject_kind === "everyone_in_tenant"
      ? { subject: null, provider: null }
      : assignment.subject_kind === "group"
        ? { subject: assignment.subject, provider: assignment.provider }
        : { subject: assignment.subject.toLowerCase(), provider: null };
  const [row] = await db
    .insert(roleAssignment)
    .values({
      role: assignment.role,
      subject_kind: assignment.subject_kind,
      ...values,
      granted_by: by.id,
    })
    .returning();
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

export async function revokeRole(db: Db, id: string): Promise<void> {
  const deleted = await db
    .delete(roleAssignment)
    .where(eq(roleAssignment.id, id))
    .returning({ id: roleAssignment.id });
  if (deleted.length === 0)
    throw new ServiceError("not_found", "No role assignment has that id.");
}

export function listAssignments(db: Db): Promise<RoleAssignment[]> {
  return db
    .select()
    .from(roleAssignment)
    .orderBy(asc(roleAssignment.role), asc(roleAssignment.granted_at));
}
