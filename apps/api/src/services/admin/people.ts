import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  inArray,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import pg from "pg";
import type { Db, ServiceContext, SettingValue } from "../../context.js";
import { session, user } from "../../db/schema/auth.js";
import { invite, openInvite } from "../../db/schema/invites.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personDeactivation } from "../../db/schema/people.js";
import { personSignIn, roleAssignment } from "../../db/schema/roles.js";
import { request, searchLog } from "../../db/schema/usage.js";
import { ServiceError } from "../../errors.js";
import { isShippedRole, SHIPPED_ROLES } from "../access/shipped-roles.js";
import {
  type Assignment,
  assignRole as insertRole,
  isDeactivated,
  listAssignments,
  MICROSOFT,
  type RoleAssignment,
  type RoleSubject,
  resolveRoles,
  revokeRole as deleteAssignment,
  roleSubject,
  subjectOnRecord,
} from "../auth/roles.js";
import { listAllGrants, signOutEverywhere } from "../auth/grants.js";
import { connectionState, endConnection } from "../connection/store.js";
import { audited, requireAdmin } from "./guard.js";

/*
 * People and their roles, over services/auth/roles.ts, which alone writes
 * role_assignment. Here are the admin's access check, the audit and the rule
 * that the last admin assignment to a person stays (hasAdmin).
 */

const ADMIN_ROLE = "admin";
const PII_READER_ROLE = "pii_reader";
export const ADMIN_ASSIGNMENTS_LOCK = "powerbi_metrics_book.admin_assignments";

/** Whether an assignment reaches the subject, as resolveRoles matches them; used to say where a role comes from, and whom an assignment would reach. */
function reaches(
  assignment: Pick<RoleAssignment, "subject_kind" | "subject" | "provider">,
  who: RoleSubject,
): boolean {
  const email = who.email.toLowerCase();
  const subject = assignment.subject?.toLowerCase();
  switch (assignment.subject_kind) {
    case "person":
      return who.email_verified && subject === email;
    case "email_domain":
      return (
        who.email_verified &&
        who.domain_verified &&
        subject === email.slice(email.lastIndexOf("@") + 1)
      );
    case "group":
      return who.groups.some(
        (group) =>
          group.provider === assignment.provider &&
          group.id === assignment.subject,
      );
    case "everyone_in_tenant":
      return who.tenant_member;
  }
}

/**
 * When a person was last seen, and how they signed in: their latest session,
 * or, once their sessions are gone (signed out, or expired), their latest
 * sign-in that still counts. A sign-in a provider's removal moved to the
 * epoch is not one.
 */
async function lastSeen(
  db: Db,
  user_id: string,
): Promise<{ method: string; at: Date } | undefined> {
  const [current] = await db
    .select({ method: session.sign_in_method, at: session.updatedAt })
    .from(session)
    .where(eq(session.userId, user_id))
    .orderBy(desc(session.updatedAt))
    .limit(1);
  if (current !== undefined) return current;
  const [signed_in] = await db
    .select({ method: personSignIn.provider, at: personSignIn.signed_in_at })
    .from(personSignIn)
    .where(
      and(
        eq(personSignIn.user_id, user_id),
        gt(personSignIn.signed_in_at, new Date(0)),
      ),
    )
    .orderBy(desc(personSignIn.signed_in_at))
    .limit(1);
  return signed_in;
}

/**
 * Each person with their sign-in method, last seen, Power BI connection, and
 * their roles now, each with the assignments that give it; `by_default` when
 * access.default_role does; where pii_reader comes from, `direct` when an
 * assignment to them gives it; and their MCP and CLI grants, which the admin
 * may end. A deactivated person's roles are what Reactivate gives back:
 * what resolveRoles answers for them without the deactivation.
 */
export async function listPeople(context: ServiceContext) {
  await requireAdmin(context, "manage_people");
  const now = context.clock();
  const assignments = await listAssignments(context.db);
  const people = await context.db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      email_verified: user.emailVerified,
      deactivated_at: personDeactivation.deactivated_at,
    })
    .from(user)
    .leftJoin(personDeactivation, eq(personDeactivation.user_id, user.id))
    .orderBy(asc(user.email));
  const grants = await listAllGrants(context.db);
  const listed = [];
  for (const person of people) {
    const who = await roleSubject(context.db, person, now);
    const reaching = assignments.filter((a) => reaches(a, who));
    const roles = await resolveRoles(context, { ...who, deactivated: false });
    const pii = reaching.filter((a) => a.role === PII_READER_ROLE);
    const last = await lastSeen(context.db, person.id);
    listed.push({
      id: person.id,
      name: person.name,
      email: person.email,
      status:
        person.deactivated_at === null
          ? ("active" as const)
          : ("deactivated" as const),
      deactivated_at: person.deactivated_at,
      direct_role:
        assignments.find(
          (a) =>
            a.subject_kind === "person" &&
            a.subject === person.email.toLowerCase() &&
            PERSON_ROLES.some((role) => role === a.role),
        )?.role ?? null,
      pii_reader: {
        source: pii.some((a) => a.subject_kind === "person")
          ? ("direct" as const)
          : pii.length > 0
            ? ("inherited" as const)
            : ("none" as const),
        assignments: pii,
      },
      sign_in_method: last?.method ?? null,
      last_seen_at: last?.at ?? null,
      powerbi_connection: await connectionState(context.db, person.id),
      grants: grants.get(person.id) ?? [],
      roles: roles.map((role) => {
        const from = reaching.filter((assignment) => assignment.role === role);
        return { role, assignments: from, by_default: from.length === 0 };
      }),
    });
  }
  return listed;
}

export async function listRoleAssignments(
  context: ServiceContext,
): Promise<RoleAssignment[]> {
  await requireAdmin(context, "manage_people");
  return listAssignments(context.db);
}

/** The database decides what a valid assignment is; its refusals answer as the caller's mistake. */
async function checked<T>(statement: Promise<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!(cause instanceof pg.DatabaseError)) throw error;
    if (cause.code === "23505")
      throw new ServiceError(
        "conflict",
        "That role is already assigned to that subject.",
      );
    if (cause.code === "23514")
      throw new ServiceError(
        "invalid",
        `The assignment is not valid (${cause.constraint ?? cause.message}).`,
      );
    // An id that is not a uuid names no assignment.
    if (cause.code === "22P02")
      throw new ServiceError("not_found", "No role assignment has that id.");
    throw error;
  }
}

/**
 * Inserts without auditing, for a caller that audits once its transaction
 * commits. A shipped role, or with `custom` one a company's own policies
 * name, so a typo is never assigned; admin only to a person or a group; a
 * group named by its provider, microsoft for Entra or one in
 * sign_in.providers. Never one that reaches the caller (refuseSelfAssignment).
 */
export async function insertAssignment(
  context: ServiceContext,
  assignment: Assignment,
  options: { custom?: boolean; first_admin?: boolean },
): Promise<RoleAssignment> {
  await refuseInvalid(context, assignment, options);
  return insertValid(context, assignment, options);
}

/** What insertAssignment refuses before it looks at who asks: a role, a subject or a provider that is not allowed. */
async function refuseInvalid(
  context: ServiceContext,
  assignment: Assignment,
  options: { custom?: boolean },
) {
  const { role, subject_kind } = assignment;
  if (!isShippedRole(role) && options.custom !== true)
    throw new ServiceError(
      "invalid",
      `${role} is not a shipped role (${SHIPPED_ROLES.join(", ")}). To assign a role your own Cerbos policies define, say it is custom (pbmb admin roles assign --custom).`,
    );
  const wide = subject_kind !== "person" && subject_kind !== "group";
  if (role === ADMIN_ROLE && wide)
    throw new ServiceError(
      "invalid",
      "admin is assigned to a person or a group only, never to everyone in the tenant or an email domain.",
    );
  if (role === PII_READER_ROLE && wide)
    throw new ServiceError(
      "invalid",
      "pii_reader is given to people or groups, never to everyone in the tenant or a whole email domain.",
    );
  if (subject_kind === "group") {
    const providers = await context.settings.get("sign_in.providers");
    const known = [MICROSOFT, ...providers.map((provider) => provider.id)];
    if (!known.includes(assignment.provider))
      throw new ServiceError(
        "invalid",
        `A group's provider is one of ${known.join(", ")}, not ${assignment.provider}.`,
      );
  }
}

async function insertValid(
  context: ServiceContext,
  assignment: Assignment,
  options: { first_admin?: boolean },
): Promise<RoleAssignment> {
  // Setup's first admin assigns admin to their own email.
  if (options.first_admin !== true)
    await refuseSelfAssignment(context, assignment);
  return checked(insertRole(context.db, assignment, context.principal));
}

/** The caller's own user, none for a service account. */
async function caller(context: ServiceContext) {
  if (context.principal.kind !== "person") return undefined;
  const [me] = await context.db
    .select({
      id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, context.principal.id));
  return me;
}

/**
 * Nobody gives themselves a role. By their own email, no role. Through a
 * group, a domain or the tenant, no role that gives more than admin:
 * pii_reader, or a custom role, whose powers live in Cerbos policies the api
 * cannot read (docs/decisions/access.md).
 */
async function refuseSelfAssignment(
  context: ServiceContext,
  assignment: Assignment,
) {
  const me = await caller(context);
  if (me === undefined) return;
  if (assignment.subject_kind === "person") {
    if (assignment.subject.toLowerCase() === me.email.toLowerCase())
      throw new ServiceError("conflict", OWN_ROLE);
    return;
  }
  if (isShippedRole(assignment.role) && assignment.role !== PII_READER_ROLE)
    return;
  // Not only whom they are now: a group dropped by Disconnect or gone stale comes back with the next read.
  const who = await subjectOnRecord(context.db, me);
  if (reaches({ subject: null, provider: null, ...assignment }, who))
    throw new ServiceError("conflict", OWN_ROLE);
}

export const assignmentDetail = (row: RoleAssignment) => ({
  role: row.role,
  subject_kind: row.subject_kind,
  subject: row.subject,
  provider: row.provider,
});

export async function assignRole(
  context: ServiceContext,
  assignment: Assignment,
  options: { custom?: boolean; first_admin?: boolean } = {},
): Promise<RoleAssignment> {
  await requireAdmin(context, "manage_people");
  // The settings it reads are read before the lock: under it, only this transaction's connection is used.
  await refuseInvalid(context, assignment, options);
  const row = await withAdminLock(
    context,
    (tx) => insertValid({ ...context, db: tx }, assignment, options),
    options,
  );
  const resource = { kind: "role_assignment", id: row.id };
  await audited(context, "role.assign", resource, assignmentDetail(row));
  return row;
}

/**
 * Whether someone can administer: an admin assignment to a person, unless
 * the email is a user's who is deactivated or whose stored email no sign-in
 * vouches for. An email no user holds yet counts. A group's or a domain's
 * may reach nobody who can sign in.
 */
export async function hasAdmin(db: Db): Promise<boolean> {
  // Same predicate as deployment_has_admin() in db/sql/tenant.sql.
  const [row] = await db
    .select({ id: roleAssignment.id })
    .from(roleAssignment)
    .where(
      and(
        eq(roleAssignment.role, ADMIN_ROLE),
        eq(roleAssignment.subject_kind, "person"),
        notExists(
          db
            .select({ id: user.id })
            .from(user)
            .leftJoin(
              personDeactivation,
              eq(personDeactivation.user_id, user.id),
            )
            .where(
              and(
                sql`lower(${user.email}) = ${roleAssignment.subject}`,
                or(
                  isNotNull(personDeactivation.user_id),
                  eq(user.emailVerified, false),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Refuses to remove the last admin assignment to a person, so someone can always administer. */
export async function revokeRole(
  context: ServiceContext,
  id: string,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  const { revoked, invites } = await checked(
    // Two admins revoking each other at once take turns, so one of them stays.
    withAdminLock(context, async (tx, held) => {
      const admins = await invitingAdmins(context, tx, held);
      const [row] = await tx
        .select()
        .from(roleAssignment)
        .where(eq(roleAssignment.id, id));
      const me = await caller({ ...context, db: tx });
      if (
        me !== undefined &&
        row?.subject_kind === "person" &&
        row.subject?.toLowerCase() === me.email.toLowerCase()
      )
        throw new ServiceError("conflict", OWN_ROLE);
      await deleteAssignment(tx, id);
      // Thrown inside the transaction, so the delete rolls back.
      if (row?.role === ADMIN_ROLE && !(await hasAdmin(tx)))
        throw new ServiceError(
          "conflict",
          "This is the last admin assignment to a person. Assign admin to someone else first.",
        );
      // A demoted admin's open invites would still admit people on their word.
      const invites = await revokeDemotedInvites(context, tx, held, admins);
      return { revoked: row, invites };
    }),
  );
  await auditRevokedInvites(context, invites);
  const resource = { kind: "role_assignment", id };
  await audited(context, "role.revoke", resource, {
    role: revoked?.role ?? null,
    subject: revoked?.subject ?? null,
  });
}
const PERSON_ROLES = ["viewer", "curator", "admin"] as const;
type PersonRole = (typeof PERSON_ROLES)[number];
const OWN_ROLE = "You cannot change your own role. Ask another admin.";
const LAST_ADMIN =
  "This is the last active admin. Make someone else an admin first.";

/** Another admin changes your access, never you. */
function refuseOwn(
  context: ServiceContext,
  userId: string,
  sentence: string = OWN_ROLE,
) {
  if (userId === context.principal.id)
    throw new ServiceError("conflict", sentence);
}
const personAssignments = (email: string) =>
  and(
    eq(roleAssignment.subject_kind, "person"),
    eq(roleAssignment.subject, email.toLowerCase()),
  );

async function findPerson(db: Db, userId: string) {
  const [person] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  if (person === undefined)
    throw new ServiceError("not_found", "No such person.");
  return person;
}

function auditPerson(
  context: ServiceContext,
  action: string,
  person: { id: string; email: string },
  detail: Record<string, unknown> = {},
) {
  return audited(
    context,
    action,
    { kind: "person", id: person.id },
    { email: person.email, ...detail },
  );
}

/** A person as resolveRoles reads them. */
type Person = { id: string; email: string; email_verified: boolean };

/** Whether admin reaches a person now, and through anything on record for them, however old. */
type HeldAdmin = { now: boolean; on_record: boolean };

/** What a change holding the lock can ask, as this transaction sees it. */
export type AdminLock = {
  /** The roles that reach a person now. */
  rolesOf(person: Person): Promise<string[]>;
  heldAdmin(person: Person): Promise<HeldAdmin>;
};

/**
 * Runs work in a transaction that holds the admin lock (lockAsAdmin). The
 * default role is read before the transaction opens, so the work never
 * borrows a second connection.
 */
export async function withAdminLock<T>(
  context: ServiceContext,
  work: (tx: Db, held: AdminLock) => Promise<T>,
  options: { first_admin?: boolean } = {},
): Promise<T> {
  const fallback = await context.settings.get("access.default_role");
  return context.db.transaction(async (tx) =>
    work(tx, await lockAsAdmin(context, tx, fallback, options)),
  );
}

/**
 * Every change to who administers, and every invite, takes this lock, so none
 * slips past another. A deactivation, a role change and a delete commit under
 * it, so the caller's roles are read again here: one Cerbos decided on and
 * since taken away refuses the change. Cerbos is not asked again, because it
 * reads settings on another connection; for the same reason the caller reads
 * the default role first, before the transaction or through it. Setup's first
 * admin is not one yet.
 */
export async function lockAsAdmin(
  context: ServiceContext,
  tx: Db,
  fallback: SettingValue<"access.default_role">,
  options: { first_admin?: boolean } = {},
): Promise<AdminLock> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ADMIN_ASSIGNMENTS_LOCK}, 0))`,
  );
  const deps = { db: tx, settings: { get: () => Promise.resolve(fallback) } };
  // One moment for every read under the lock, so a before and an after of the
  // same change differ only by the change.
  const now = context.clock();
  const held: AdminLock = {
    rolesOf: async (person) =>
      resolveRoles(deps, await roleSubject(tx, person, now)),
    heldAdmin: async (person) => ({
      now: (await held.rolesOf(person)).includes(ADMIN_ROLE),
      on_record: (
        await resolveRoles(deps, await subjectOnRecord(tx, person))
      ).includes(ADMIN_ROLE),
    }),
  };
  if (context.principal.kind !== "person") return held;
  if (await isDeactivated(tx, context.principal.id))
    throw new ServiceError(
      "refused",
      "An admin deactivated you, so this change was refused.",
    );
  if (options.first_admin === true) return held;
  const me = await caller({ ...context, db: tx });
  const roles = me === undefined ? [] : await held.rolesOf(me);
  if (!context.principal.roles.every((role) => roles.includes(role)))
    throw new ServiceError(
      "refused",
      "An admin changed your role, so this change was refused.",
    );
  return held;
}

/** Ends the open invites the given people sent: an invite admits on its inviter's word. */
function revokeOpenInvites(
  context: ServiceContext,
  tx: Db,
  inviters: readonly string[],
) {
  if (inviters.length === 0) return Promise.resolve([]);
  return tx
    .update(invite)
    .set({ revoked_at: context.clock(), revoked_by: context.principal.id })
    .where(and(inArray(invite.invited_by, inviters), openInvite))
    .returning({ email: invite.email });
}

export async function auditRevokedInvites(
  context: ServiceContext,
  invites: readonly { email: string }[],
) {
  for (const { email } of invites)
    await audited(
      context,
      "people.invite_revoke",
      { kind: "person", id: email },
      { email },
    );
}

/**
 * The people with unexpired open invites who hold admin, now or on record,
 * with which. On record too: revoking a group whose evidence went stale, or
 * that a Disconnect cleared, takes from the person the admin it gave them.
 */
export async function invitingAdmins(
  context: ServiceContext,
  tx: Db,
  held: AdminLock,
): Promise<{ person: Person; before: HeldAdmin }[]> {
  const inviters = await tx
    .selectDistinct({
      id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
    })
    .from(invite)
    .innerJoin(user, eq(user.id, invite.invited_by))
    .where(and(openInvite, gt(invite.expires_at, context.clock())));
  const admins: { person: Person; before: HeldAdmin }[] = [];
  for (const person of inviters) {
    const before = await held.heldAdmin(person);
    if (before.now || before.on_record) admins.push({ person, before });
  }
  return admins;
}

/**
 * After a change to roles, ends the open invites of each of these admins it
 * took admin from, now or on record: a person demoted in the app is demoted
 * though a stale group on record still names them.
 */
export async function revokeDemotedInvites(
  context: ServiceContext,
  tx: Db,
  held: AdminLock,
  admins: readonly { person: Person; before: HeldAdmin }[],
) {
  const demoted: string[] = [];
  for (const { person, before } of admins) {
    const after = await held.heldAdmin(person);
    if ((before.now && !after.now) || (before.on_record && !after.on_record))
      demoted.push(person.id);
  }
  return revokeOpenInvites(context, tx, demoted);
}

export async function deactivatePerson(
  context: ServiceContext,
  userId: string,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  refuseOwn(
    context,
    userId,
    "You cannot deactivate yourself. Ask another admin.",
  );
  const { person, invites } = await withAdminLock(context, async (tx) => {
    const person = await findPerson(tx, userId);
    const inserted = await tx
      .insert(personDeactivation)
      .values({
        user_id: userId,
        deactivated_by: context.principal.id,
        deactivated_at: context.clock(),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0)
      throw new ServiceError(
        "conflict",
        `${person.email} is already deactivated.`,
      );
    await signOutEverywhere(tx, userId);
    await endConnection(tx, userId, { status: "disconnected" });
    // Their open invites would still grant their role once they are gone.
    const invites = await revokeOpenInvites(context, tx, [userId]);
    if (!(await hasAdmin(tx))) throw new ServiceError("conflict", LAST_ADMIN);
    return { person, invites };
  });
  await auditRevokedInvites(context, invites);
  await auditPerson(context, "people.deactivate", person);
}

/**
 * Ends a person's browser sessions and MCP and CLI grants, so they sign in
 * again everywhere, for a lost or shared device. Unlike Deactivate it keeps
 * their roles, their open invites and their Power BI connection.
 */
export async function signOutPerson(
  context: ServiceContext,
  userId: string,
): Promise<void> {
  await requireAdmin(context, "sign_out_person");
  refuseOwn(
    context,
    userId,
    "You cannot sign yourself out here. Use Sign out of all other sessions under Connections, Sessions.",
  );
  const person = await withAdminLock(context, async (tx) => {
    const person = await findPerson(tx, userId);
    await signOutEverywhere(tx, userId);
    return person;
  });
  await auditPerson(context, "people.sign_out", person);
}

export async function reactivatePerson(
  context: ServiceContext,
  userId: string,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  refuseOwn(
    context,
    userId,
    "You cannot reactivate yourself. Ask another admin.",
  );
  const person = await withAdminLock(context, async (tx) => {
    const person = await findPerson(tx, userId);
    const deleted = await tx
      .delete(personDeactivation)
      .where(eq(personDeactivation.user_id, userId))
      .returning();
    if (deleted.length === 0)
      throw new ServiceError("not_found", "This person is not deactivated.");
    return person;
  });
  await auditPerson(context, "people.reactivate", person);
}

export async function deletePerson(
  context: ServiceContext,
  userId: string,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  const person = await withAdminLock(context, async (tx) => {
    const person = await findPerson(tx, userId);
    const [deactivated] = await tx
      .select()
      .from(personDeactivation)
      .where(eq(personDeactivation.user_id, userId));
    if (deactivated === undefined)
      throw new ServiceError("conflict", `Deactivate ${person.email} first.`);
    await tx.delete(personIdentity).where(eq(personIdentity.user_id, userId));
    await tx.delete(roleAssignment).where(personAssignments(person.email));
    for (const table of [request, searchLog]) {
      await tx
        .delete(table)
        .where(
          and(
            eq(table.principal_kind, "person"),
            eq(table.principal_id, userId),
          ),
        );
    }
    await tx.delete(user).where(eq(user.id, userId));
    return person;
  });
  await auditPerson(context, "people.delete", person);
}

export async function setPersonRole(
  context: ServiceContext,
  userId: string,
  role: PersonRole,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  refuseOwn(context, userId);
  const { person, from, invites } = await withAdminLock(
    context,
    async (tx, held) => {
      const admins = await invitingAdmins(context, tx, held);
      const person = await findPerson(tx, userId);
      const removed = await tx
        .delete(roleAssignment)
        .where(
          and(
            personAssignments(person.email),
            inArray(roleAssignment.role, PERSON_ROLES),
          ),
        )
        .returning();
      await insertAssignment(
        { ...context, db: tx },
        { role, subject_kind: "person", subject: person.email },
        {},
      );
      if (!(await hasAdmin(tx))) throw new ServiceError("conflict", LAST_ADMIN);
      // A demoted admin's open invites would still admit people on their word.
      const invites = await revokeDemotedInvites(context, tx, held, admins);
      return { person, from: removed[0]?.role ?? null, invites };
    },
  );
  await auditRevokedInvites(context, invites);
  await auditPerson(context, "role.change", person, { from, to: role });
}

export async function setPiiReader(
  context: ServiceContext,
  userId: string,
  allowed: boolean,
): Promise<void> {
  await requireAdmin(context, "manage_people");
  refuseOwn(context, userId);
  const person = await findPerson(context.db, userId);
  if (allowed) {
    await assignRole(context, {
      role: PII_READER_ROLE,
      subject_kind: "person",
      subject: person.email,
    });
  } else {
    const assignment = (await listAssignments(context.db)).find(
      (a) =>
        a.subject_kind === "person" &&
        a.subject === person.email.toLowerCase() &&
        a.role === PII_READER_ROLE,
    );
    if (assignment === undefined)
      throw new ServiceError(
        "not_found",
        "No PII reader assignment for this person.",
      );
    await revokeRole(context, assignment.id);
  }
}
