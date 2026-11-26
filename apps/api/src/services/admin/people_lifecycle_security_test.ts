import { createMetric, getMetric } from "../book/metrics.js";
import { setOwner, setTitle } from "../book/ownership.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import {
  adminOnRecord,
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { Access, ServiceContext } from "../../context.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  oauthClient,
  oauthConsent,
  session,
  user,
} from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { invite } from "../../db/schema/invites.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personDeactivation } from "../../db/schema/people.js";
import { personSignIn, roleAssignment } from "../../db/schema/roles.js";
import { setupLink } from "../../db/schema/setup.js";
import { createSettingsStore } from "../settings/store.js";
import { invitePeople, resendInvite, revokeInvite } from "../auth/invites.js";
import { currentConventions } from "../conventions/store.js";
import { firstAdmin, setupPrincipal } from "../setup/link.js";
import { importBook } from "./export.js";
import * as people from "./people.js";

afterAll(closeTestPools);
const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = {
  ...deps,
  principal: await adminOnRecord(deps, { through: "group" }),
};
async function person(role = "viewer") {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await deps.db
    .insert(user)
    .values({ id, email, name: email, emailVerified: true });
  await people.assignRole(admin, {
    role,
    subject_kind: "person",
    subject: email,
  });
  return { id, email };
}

it("deactivation ends sessions, grants and Power BI without changing assignments", async () => {
  await person("admin");
  const target = await person();
  const oid = randomUUID();
  await deps.db.insert(session).values({
    id: randomUUID(),
    token: randomUUID(),
    userId: target.id,
    sign_in_method: "microsoft",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const clientId = randomUUID();
  await deps.db.insert(oauthClient).values({
    id: randomUUID(),
    clientId,
    redirectUris: [],
    createdAt: new Date(),
  });
  await deps.db.insert(oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId: target.id,
    scopes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await deps.db.insert(personIdentity).values({
    user_id: target.id,
    microsoft_object_id: oid,
    groups_read_at: new Date(),
  });
  await deps.db.insert(powerbiConnection).values({
    user_id: target.id,
    microsoft_object_id: oid,
    status: "connected",
    connected_at: new Date(),
    groups_read_at: new Date(),
    access_token_ciphertext: new Uint8Array([1]),
    refresh_token_ciphertext: new Uint8Array([2]),
    access_token_expires_at: new Date(),
    recipient: "sample",
  });
  const assignments = await people.listRoleAssignments(admin);
  await people.deactivatePerson(admin, target.id);
  expect(
    await deps.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, target.id)),
  ).toEqual([]);
  expect(
    await deps.db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, target.id)),
  ).toEqual([]);
  expect(
    await deps.db
      .select({
        status: powerbiConnection.status,
        access: powerbiConnection.access_token_ciphertext,
        refresh: powerbiConnection.refresh_token_ciphertext,
        groups: powerbiConnection.groups_read_at,
      })
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, target.id)),
  ).toEqual([
    { status: "disconnected", access: null, refresh: null, groups: null },
  ]);
  expect(
    (
      await deps.db
        .select({ groups: personIdentity.groups_read_at })
        .from(personIdentity)
        .where(eq(personIdentity.user_id, target.id))
    )[0]?.groups,
  ).toBeNull();
  expect(await people.listRoleAssignments(admin)).toEqual(assignments);
});
it("refuses self-deactivation, active deletion, and unauthorized lifecycle changes", async () => {
  await expect(
    people.deactivatePerson(admin, admin.principal.id),
  ).rejects.toThrow("You cannot deactivate yourself. Ask another admin.");
  const target = await person();
  await expect(people.deletePerson(admin, target.id)).rejects.toThrow(
    `Deactivate ${target.email} first.`,
  );
  for (const principal of [
    principals.viewer,
    principals.curator,
    { ...principals.admin, kind: "service_account" as const },
  ]) {
    const context = { ...deps, principal };
    for (const call of [
      () => people.deactivatePerson(context, target.id),
      () => people.reactivatePerson(context, target.id),
      () => people.deletePerson(context, target.id),
      () => people.setPersonRole(context, target.id, "admin"),
      () => people.setPiiReader(context, target.id, true),
    ])
      await expect(call()).rejects.toMatchObject({ kind: "refused" });
  }
});
it("serializes concurrent deactivations and keeps the last active admin", async () => {
  // The last-admin rule counts assignments to a person; the caller's comes through a group.
  await deps.db
    .delete(roleAssignment)
    .where(
      and(
        eq(roleAssignment.role, "admin"),
        eq(roleAssignment.subject_kind, "person"),
      ),
    );
  const a = await person("admin");
  const b = await person("admin");
  const results = await Promise.allSettled([
    people.deactivatePerson(
      { ...admin, principal: { ...admin.principal, id: a.id } },
      b.id,
    ),
    people.deactivatePerson(
      { ...admin, principal: { ...admin.principal, id: b.id } },
      a.id,
    ),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const [ended] = await deps.db
    .select()
    .from(personDeactivation)
    .where(eq(personDeactivation.user_id, a.id));
  const active = ended === undefined ? a : b;
  await expect(people.deactivatePerson(admin, active.id)).rejects.toThrow(
    "This is the last active admin. Make someone else an admin first.",
  );
  await expect(
    people.setPersonRole(admin, active.id, "viewer"),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(await people.hasAdmin(deps.db)).toBe(true);
});
it("deactivating an inviter revokes their open invites in the same change, and audits each", async () => {
  await person("admin");
  const inviter = await person("admin");
  const invited = (email: string, invited_by: string) => ({
    email,
    role: "admin",
    token_sha256: randomBytes(32).toString("hex"),
    invited_by,
    expires_at: new Date(Date.now() + 3600_000),
  });
  const emails = [1, 2, 3, 4, 5].map(() => `${randomUUID()}@example.test`);
  const [open, expired, accepted, others, already] = emails as [
    string,
    string,
    string,
    string,
    string,
  ];
  const other = await person("admin");
  await deps.db.insert(invite).values([
    invited(open, inviter.id),
    { ...invited(expired, inviter.id), expires_at: new Date(Date.now() - 1) },
    { ...invited(accepted, inviter.id), accepted_at: new Date() },
    invited(others, admin.principal.id),
    {
      ...invited(already, inviter.id),
      revoked_at: new Date(),
      revoked_by: other.id,
    },
  ]);
  await people.deactivatePerson(admin, inviter.id);
  const rows = await deps.db
    .select({ email: invite.email, revoked_by: invite.revoked_by })
    .from(invite)
    .where(inArray(invite.email, emails));
  const revokedBy = (email: string) =>
    rows.find((row) => row.email === email)?.revoked_by;
  expect(revokedBy(open)).toBe(admin.principal.id);
  expect(revokedBy(expired)).toBe(admin.principal.id);
  expect(revokedBy(accepted)).toBeNull();
  expect(revokedBy(others)).toBeNull();
  expect(revokedBy(already)).toBe(other.id);
  const audits = await deps.db
    .select({ id: auditEvent.resource_id, detail: auditEvent.detail })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, "admin.people.invite_revoke"),
        inArray(auditEvent.resource_id, emails),
      ),
    );
  expect(audits.map((a) => a.id).sort()).toEqual([open, expired].sort());
  expect(audits).toContainEqual({ id: open, detail: { email: open } });
});
it("deactivating an admin revokes an invite they renewed, though another admin first sent it", async () => {
  await person("admin");
  const renewer = await person("admin");
  const asRenewer = {
    ...admin,
    principal: { ...admin.principal, id: renewer.id },
  };
  const email = `${randomUUID()}@example.test`;
  await invitePeople(admin, {
    emails: [email],
    role: "viewer",
    delivery: "link",
  });
  await invitePeople(asRenewer, {
    emails: [email],
    role: "curator",
    delivery: "link",
  });
  await people.deactivatePerson(admin, renewer.id);
  const [row] = await deps.db
    .select({ role: invite.role, revoked_by: invite.revoked_by })
    .from(invite)
    .where(eq(invite.email, email));
  expect(row).toEqual({ role: "curator", revoked_by: admin.principal.id });
});

it("leaves an inviter's invites open when their deactivation is refused", async () => {
  // The last-admin rule counts assignments to a person; the caller's comes through a group.
  await deps.db
    .delete(roleAssignment)
    .where(
      and(
        eq(roleAssignment.role, "admin"),
        eq(roleAssignment.subject_kind, "person"),
      ),
    );
  const only = await person("admin");
  const email = `${randomUUID()}@example.test`;
  await deps.db.insert(invite).values({
    email,
    role: "viewer",
    token_sha256: randomBytes(32).toString("hex"),
    invited_by: only.id,
    expires_at: new Date(Date.now() + 3600_000),
  });
  await expect(people.deactivatePerson(admin, only.id)).rejects.toThrow(
    "This is the last active admin. Make someone else an admin first.",
  );
  const [row] = await deps.db
    .select({ revoked_at: invite.revoked_at })
    .from(invite)
    .where(eq(invite.email, email));
  expect(row?.revoked_at).toBeNull();
});
it("refuses an admin changing their own role or PII, or assigning themselves a role, and changes nothing", async () => {
  await person("admin");
  const self = await person("admin");
  const own = { ...admin, principal: { ...admin.principal, id: self.id } };
  const before = await people.listRoleAssignments(admin);
  const refusal = {
    kind: "conflict",
    message: "You cannot change your own role. Ask another admin.",
  };
  await expect(
    people.setPersonRole(own, self.id, "viewer"),
  ).rejects.toMatchObject(refusal);
  for (const allowed of [true, false])
    await expect(
      people.setPiiReader(own, self.id, allowed),
    ).rejects.toMatchObject(refusal);
  for (const role of ["pii_reader", "curator"])
    await expect(
      people.assignRole(own, {
        role,
        subject_kind: "person",
        subject: self.email.toUpperCase(),
      }),
    ).rejects.toMatchObject(refusal);
  expect(await people.listRoleAssignments(admin)).toEqual(before);
  await people.assignRole(own, {
    role: "pii_reader",
    subject_kind: "person",
    subject: (await person()).email,
  });
  await people.setPersonRole(admin, self.id, "curator");
});
const ownRole = {
  kind: "conflict",
  message: "You cannot change your own role. Ask another admin.",
};
async function selfAdmin() {
  await person("admin");
  const self = await person("admin");
  const principal = { ...admin.principal, id: self.id };
  return { self, own: { ...admin, principal } };
}
const DAYS = 24 * 60 * 60 * 1000;
it.each([
  ["read now", new Date()],
  ["read 8 days ago", new Date(Date.now() - 8 * DAYS)],
  ["cleared by Disconnect", null],
])(
  "refuses an admin a role beyond admin's through a group, domain or tenant on record for them, %s, and allows a shipped one",
  async (_, read) => {
    const { self, own } = await selfAdmin();
    const group = randomUUID();
    await deps.db.insert(personIdentity).values({
      user_id: self.id,
      group_object_ids: [group],
      groups_read_at: read,
    });
    await deps.db.insert(personSignIn).values({
      user_id: self.id,
      provider: "microsoft",
      signed_in_at: read ?? new Date(Date.now() - 30 * DAYS),
      domain_verified: read !== null,
    });
    const before = await people.listRoleAssignments(admin);
    const inGroup = {
      subject_kind: "group",
      provider: "microsoft",
      subject: group,
    } as const;
    for (const reaching of [
      { role: "pii_reader", ...inGroup },
      { role: "analyst", ...inGroup },
      {
        role: "analyst",
        subject_kind: "email_domain",
        subject: "Example.test",
      },
      { role: "analyst", subject_kind: "everyone_in_tenant" },
    ] as const)
      await expect(
        people.assignRole(own, reaching, { custom: true }),
      ).rejects.toMatchObject(ownRole);
    expect(await people.listRoleAssignments(admin)).toEqual(before);
    const allowed = [
      await people.assignRole(own, { role: "viewer", ...inGroup }),
      await people.assignRole(own, {
        role: "pii_reader",
        ...inGroup,
        subject: randomUUID(),
      }),
    ];
    for (const { id } of allowed) await people.revokeRole(admin, id);
  },
);

it("refuses an admin pii_reader through another provider's group from an old sign-in, and a custom role for the tenant from a Microsoft account on record", async () => {
  const { self, own } = await selfAdmin();
  const provider = {
    id: "probe_idp",
    kind: "google" as const,
    label: "Probe",
    client_id: "client",
    issuer: null,
  };
  const withProvider = {
    ...own,
    settings: new MemorySettings({ "sign_in.providers": [provider] }),
  };
  const group = randomUUID();
  await deps.db.insert(personSignIn).values({
    user_id: self.id,
    provider: provider.id,
    group_ids: [group],
    signed_in_at: new Date(Date.now() - 30 * DAYS),
  });
  await deps.db.insert(personIdentity).values({
    user_id: self.id,
    microsoft_object_id: randomUUID(),
    group_object_ids: [],
    groups_read_at: null,
  });
  const before = await people.listRoleAssignments(admin);
  await expect(
    people.assignRole(withProvider, {
      role: "pii_reader",
      subject_kind: "group",
      provider: provider.id,
      subject: group,
    }),
  ).rejects.toMatchObject(ownRole);
  await expect(
    people.assignRole(
      own,
      { role: "analyst", subject_kind: "everyone_in_tenant" },
      { custom: true },
    ),
  ).rejects.toMatchObject(ownRole);
  expect(await people.listRoleAssignments(admin)).toEqual(before);
});
it("refuses an import that assigns the importing admin a role, and writes nothing", async () => {
  const { self, own } = await selfAdmin();
  const before = await people.listRoleAssignments(admin);
  const file = [
    "format: 1",
    "role_assignments:",
    `  - { role: viewer, subject_kind: person, subject: ${randomUUID()}@example.test }`,
    `  - { role: curator, subject_kind: person, subject: ${self.email.toUpperCase()} }`,
  ].join("\n");
  const settings = createSettingsStore(deps.db, {});
  await expect(
    importBook({ ...own, settings }, file, { apply: true }),
  ).rejects.toMatchObject(ownRole);
  expect(await people.listRoleAssignments(admin)).toEqual(before);
});
it("refuses an admin revoking their own assignment, whatever their email's case", async () => {
  const id = randomUUID();
  const email = `${id.toUpperCase()}@Example.test`;
  await deps.db
    .insert(user)
    .values({ id, email, name: email, emailVerified: true });
  await people.assignRole(admin, {
    role: "admin",
    subject_kind: "person",
    subject: email,
  });
  const pii = await people.assignRole(admin, {
    role: "pii_reader",
    subject_kind: "person",
    subject: email,
  });
  const own = { ...admin, principal: { ...admin.principal, id } };
  await expect(people.revokeRole(own, pii.id)).rejects.toMatchObject(ownRole);
  const held = await people.listRoleAssignments(admin);
  expect(held.map((a) => a.id)).toContain(pii.id);
  await people.revokeRole(admin, pii.id);
});

/** An open invite another admin sent, for a change to try to resend or revoke. */
async function pendingInvite() {
  const [row] = await deps.db
    .insert(invite)
    .values({
      email: `${randomUUID()}@example.test`,
      role: "viewer",
      token_sha256: randomBytes(32).toString("hex"),
      invited_by: admin.principal.id,
      delivery: "link",
      expires_at: new Date(Date.now() + 3600_000),
      last_sent_at: new Date(Date.now() - 3600_000),
    })
    .returning({ id: invite.id });
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

/** Every change that takes the admin lock, as the caller `own`, on people another admin set up. */
function lockedChanges(
  own: typeof admin,
  {
    other,
    gone,
  }: { other: { id: string; email: string }; gone: { id: string } },
  assignment: { id: string },
  pending: { id: string },
) {
  return [
    () => resendInvite(own, pending.id),
    () => revokeInvite(own, pending.id),
    () => people.reactivatePerson(own, gone.id),
    () => people.deactivatePerson(own, other.id),
    () => people.deletePerson(own, gone.id),
    () => people.setPersonRole(own, other.id, "admin"),
    () => people.setPiiReader(own, other.id, true),
    () => people.revokeRole(own, assignment.id),
    () =>
      people.assignRole(own, {
        role: "curator",
        subject_kind: "person",
        subject: other.email,
      }),
    () =>
      invitePeople(own, {
        emails: [`${randomUUID()}@example.test`],
        role: "admin",
        delivery: "link",
      }),
    () =>
      importBook(
        { ...own, settings: createSettingsStore(deps.db, {}) },
        [
          "format: 1",
          "role_assignments:",
          `  - { role: viewer, subject_kind: person, subject: ${randomUUID()}@example.test }`,
        ].join("\n"),
        { apply: true },
      ),
  ];
}

it("refuses every change from an admin deactivated after their role check, and changes nothing", async () => {
  // As a request still in flight when another admin's deactivation of its
  // caller commits: the principal holds admin, the database says deactivated.
  const { self, own } = await selfAdmin();
  const other = await person("viewer");
  const gone = await person("viewer");
  await people.deactivatePerson(admin, gone.id);
  const pending = await pendingInvite();
  await people.deactivatePerson(admin, self.id);
  const state = async () => ({
    assignments: await people.listRoleAssignments(admin),
    deactivated: await deps.db
      .select({ id: personDeactivation.user_id })
      .from(personDeactivation)
      .where(inArray(personDeactivation.user_id, [self.id, other.id, gone.id])),
    pending: await deps.db
      .select()
      .from(invite)
      .where(eq(invite.id, pending.id)),
  });
  const before = await state();
  const refused = {
    kind: "refused",
    message: "An admin deactivated you, so this change was refused.",
  };
  const assignment = before.assignments.find(
    (each) => each.subject === other.email,
  );
  if (assignment === undefined) throw new Error("other holds viewer above");
  for (const change of lockedChanges(own, { other, gone }, assignment, pending))
    await expect(change()).rejects.toMatchObject(refused);
  await expect(people.reactivatePerson(own, self.id)).rejects.toMatchObject({
    kind: "conflict",
    message: "You cannot reactivate yourself. Ask another admin.",
  });
  expect(await state()).toEqual(before);
});

it("refuses every change from an admin demoted after their role check, and changes nothing", async () => {
  // As a request still in flight when another admin's change of its caller's
  // role commits: the principal holds admin, the database says viewer.
  const { self, own } = await selfAdmin();
  const other = await person("viewer");
  const gone = await person("viewer");
  await people.deactivatePerson(admin, gone.id);
  const pending = await pendingInvite();
  await people.setPersonRole(admin, self.id, "viewer");
  const state = async () => ({
    assignments: await people.listRoleAssignments(admin),
    deactivated: await deps.db
      .select({ id: personDeactivation.user_id })
      .from(personDeactivation)
      .where(inArray(personDeactivation.user_id, [self.id, other.id, gone.id])),
    invites: await deps.db
      .select()
      .from(invite)
      .where(or(eq(invite.invited_by, self.id), eq(invite.id, pending.id))),
  });
  const before = await state();
  const assignment = before.assignments.find(
    (each) => each.subject === other.email,
  );
  if (assignment === undefined) throw new Error("other holds viewer above");
  for (const change of lockedChanges(own, { other, gone }, assignment, pending))
    await expect(change()).rejects.toMatchObject({
      kind: "refused",
      message: "An admin changed your role, so this change was refused.",
    });
  expect(await state()).toEqual(before);
});

it("demoting an admin revokes their open invites in the same change, and audits each, unless they still hold admin", async () => {
  const invited = (invited_by: string) => ({
    email: `${randomUUID()}@example.test`,
    role: "viewer",
    token_sha256: randomBytes(32).toString("hex"),
    invited_by,
    expires_at: new Date(Date.now() + 3600_000),
  });
  const changed = await person("admin");
  const revoked = await person("admin");
  const expiredOnly = await person("admin");
  const grouped = await person("admin");
  const kept = await person("admin");
  // Admin through a group as well, so a change of their own role leaves them admin.
  const group = randomUUID();
  await deps.db.insert(personIdentity).values({
    user_id: grouped.id,
    group_object_ids: [group],
    groups_read_at: new Date(),
  });
  await people.assignRole(admin, {
    role: "admin",
    subject_kind: "group",
    provider: "microsoft",
    subject: group,
  });
  const rows = [changed, revoked, grouped, kept].map(({ id }) => invited(id));
  const expired = {
    ...invited(expiredOnly.id),
    expires_at: new Date(Date.now() - 1),
  };
  await deps.db.insert(invite).values([...rows, expired]);
  const [ofChanged, ofRevoked, ofGrouped, ofKept] = rows.map(
    (row) => row.email,
  ) as [string, string, string, string];
  await people.setPersonRole(admin, changed.id, "curator");
  await people.setPersonRole(admin, grouped.id, "curator");
  // An expired invite admits nobody, so demoting its only inviter leaves it.
  await people.setPersonRole(admin, expiredOnly.id, "curator");
  const assignment = (await people.listRoleAssignments(admin)).find(
    (each) => each.subject === revoked.email && each.role === "admin",
  );
  if (assignment === undefined) throw new Error("revoked holds admin above");
  await people.revokeRole(admin, assignment.id);
  const emails = [...rows, expired].map((row) => row.email);
  const after = await deps.db
    .select({ email: invite.email, revoked_by: invite.revoked_by })
    .from(invite)
    .where(inArray(invite.email, emails));
  const revokedBy = (email: string) =>
    after.find((row) => row.email === email)?.revoked_by;
  expect(revokedBy(ofChanged)).toBe(admin.principal.id);
  expect(revokedBy(ofRevoked)).toBe(admin.principal.id);
  expect(revokedBy(ofGrouped)).toBeNull();
  expect(revokedBy(ofKept)).toBeNull();
  expect(revokedBy(expired.email)).toBeNull();
  const audits = await deps.db
    .select({ id: auditEvent.resource_id, detail: auditEvent.detail })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, "admin.people.invite_revoke"),
        inArray(auditEvent.resource_id, emails),
      ),
    );
  expect(audits.map((a) => a.id).sort()).toEqual([ofChanged, ofRevoked].sort());
  expect(audits).toContainEqual({
    id: ofChanged,
    detail: { email: ofChanged },
  });
});

/** Whether any session holds the admin lock, read on a connection of its own. */
async function adminLockHeld(): Promise<boolean> {
  const { rows } = await deps.db.execute<{ held: boolean }>(
    sql`select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint)
          = hashtextextended(${people.ADMIN_ASSIGNMENTS_LOCK}, 0)
    ) as held`,
  );
  return rows[0]?.held === true;
}

/**
 * Setup's first admin, made through firstAdmin as the setup step makes it.
 * Setup binds a database's tenant once, so this unbinds it first and leaves
 * a random tenant bound: a test after it that reads the tenant gets that one.
 * It stores `none` as the default role, as setup does, and then deletes the
 * row again, so the tests after it keep the registry default.
 */
async function makeFirstAdmin(context: ServiceContext) {
  await testPool("migrator").query("delete from deployment_tenant");
  const id = randomUUID();
  const email = `${id}@example.test`;
  await deps.db
    .insert(user)
    .values({ id, email, name: email, emailVerified: true });
  const tenant_id = randomUUID();
  const [session] = await deps.db
    .insert(setupLink)
    .values({
      token_digest: randomBytes(32).toString("hex"),
      expires_at: new Date(Date.now() + 3600_000),
      admitted_user_id: id,
      signed_in_tenant_id: tenant_id,
      signed_in_sample: true,
    })
    .returning();
  if (session === undefined) throw new Error("no setup session");
  const made = await firstAdmin(
    {
      ...context,
      settings: createSettingsStore(context.db, {
        POWERBI_TENANT_ID: tenant_id,
        POWERBI_AUTHORITY: "http://localhost:4010",
      }),
      principal: setupPrincipal(session),
    },
    session,
    id,
    email,
  );
  expect(made).toEqual({ made: true });
  const stored = await testPool("migrator").query(
    "delete from setting where key = 'access.default_role' and value = '\"none\"'",
  );
  expect(stored.rowCount).toBe(1);
}

/** A book.yml that assigns a role, changes a service account and a PII rule, and sets `preset`. */
const lockedImport = (preset: string) =>
  [
    "format: 1",
    `conventions: { preset: ${preset} }`,
    "role_assignments:",
    `  - { role: viewer, subject_kind: person, subject: ${randomUUID()}@example.test }`,
    "service_accounts:",
    `  - { name: sa_${randomBytes(4).toString("hex")}, owner_email: o@example.test, roles: [viewer], workspace_ids: [], app_ids: [], source_cidrs: [], max_key_age_days: 30 }`,
    "pii_rules:",
    `  - { kind: column, table: Customer, name: Email ${randomUUID()}, pii: true }`,
  ].join("\n");
const LOCKED_IMPORT_PARTS = [
  "conventions",
  "role_assignments",
  "service_accounts",
  "pii_rules",
];
const partsOf = (imported: { changes: { path: string }[] }) =>
  imported.changes.map((c) => c.path.split(".")[0]);

it("sees the admin lock while a change holds it, and not after", async () => {
  expect(await people.withAdminLock(admin, () => adminLockHeld())).toBe(true);
  expect(await adminLockHeld()).toBe(false);
});

it("asks Cerbos nothing while the admin lock is held, in every change that takes it", async () => {
  // Cerbos reads a setting through the pool; a request waiting for a
  // connection while it holds the lock can wait for ever.
  const real = cerbosAccess(new MemorySettings());
  const underLock: string[] = [];
  const watched = async (action: string) => {
    if (await adminLockHeld()) underLock.push(action);
  };
  const access: Access = {
    check: async (principal, resource, action) => {
      await watched(action);
      return real.check(principal, resource, action);
    },
    require: async (principal, resource, action) => {
      await watched(action);
      await real.require(principal, resource, action);
    },
    reachableDatasets: async (principal) => {
      await watched("reachableDatasets");
      return real.reachableDatasets(principal);
    },
    describableDatasets: async (principal) => {
      await watched("describableDatasets");
      return real.describableDatasets(principal);
    },
    readableQueryLog: async (principal) => {
      await watched("readableQueryLog");
      return real.readableQueryLog(principal);
    },
    readableRequests: async (principal) => {
      await watched("readableRequests");
      return real.readableRequests(principal);
    },
    readableSearchLog: async (principal) => {
      await watched("readableSearchLog");
      return real.readableSearchLog(principal);
    },
  };
  const watching = { ...admin, access };
  // The last-admin rule counts a person's assignment; the caller's is a group's.
  await person("admin");
  const someone = await person("viewer");
  await people.assignRole(watching, {
    role: "curator",
    subject_kind: "person",
    subject: `${randomUUID()}@example.test`,
  });
  await people.setPersonRole(watching, someone.id, "curator");
  await people.setPiiReader(watching, someone.id, true);
  await people.setPiiReader(watching, someone.id, false);
  const sent = await invitePeople(watching, {
    emails: [`${randomUUID()}@example.test`],
    role: "viewer",
    delivery: "link",
  });
  await resendInvite(watching, (await pendingInvite()).id);
  await revokeInvite(watching, String(sent.invites[0]?.id));
  await people.deactivatePerson(watching, someone.id);
  await people.reactivatePerson(watching, someone.id);
  await people.deactivatePerson(watching, someone.id);
  await people.deletePerson(watching, someone.id);
  // The conventions save last, and the service account and the rule under the lock.
  const imported = await importBook(
    { ...watching, settings: createSettingsStore(deps.db, {}) },
    lockedImport("minimal"),
    { apply: true },
  );
  expect(partsOf(imported)).toEqual(
    expect.arrayContaining(LOCKED_IMPORT_PARTS),
  );
  await makeFirstAdmin(watching);
  expect(underLock).toEqual([]);
});

it.each([
  ["read 8 days ago", new Date(Date.now() - 8 * DAYS)],
  ["cleared by Disconnect", null],
])(
  "revoking the group that made an admin, its evidence %s, revokes the admin's open invites",
  async (_, read) => {
    await person("admin");
    const id = randomUUID();
    const email = `${id}@example.test`;
    await deps.db
      .insert(user)
      .values({ id, email, name: email, emailVerified: true });
    const group = randomUUID();
    await deps.db.insert(personIdentity).values({
      user_id: id,
      group_object_ids: [group],
      groups_read_at: read,
    });
    const assignment = await people.assignRole(admin, {
      role: "admin",
      subject_kind: "group",
      provider: "microsoft",
      subject: group,
    });
    const [sent] = await deps.db
      .insert(invite)
      .values({
        email: `${randomUUID()}@example.test`,
        role: "admin",
        token_sha256: randomBytes(32).toString("hex"),
        invited_by: id,
        expires_at: new Date(Date.now() + 3600_000),
      })
      .returning({ id: invite.id });
    await people.revokeRole(admin, assignment.id);
    const [row] = await deps.db
      .select({ revoked_by: invite.revoked_by })
      .from(invite)
      .where(eq(invite.id, String(sent?.id)));
    expect(row?.revoked_by).toBe(admin.principal.id);
  },
);

it("runs every change that takes the admin lock on one connection, so a full pool cannot stall it", async () => {
  // With one connection, a second borrow inside a transaction times out.
  const pool = new pg.Pool({
    connectionString: roleUrl("api_rw"),
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  try {
    const db = createDb(pool);
    const one = {
      ...admin,
      pool,
      db,
      settings: createSettingsStore(db, {}),
    };
    await person("admin");
    const someone = await person("viewer");
    await people.assignRole(one, {
      role: "curator",
      subject_kind: "person",
      subject: `${randomUUID()}@example.test`,
    });
    await people.setPersonRole(one, someone.id, "curator");
    await people.setPiiReader(one, someone.id, true);
    await people.setPiiReader(one, someone.id, false);
    const sent = await invitePeople(one, {
      emails: [`${randomUUID()}@example.test`],
      role: "viewer",
      delivery: "link",
    });
    await resendInvite(one, (await pendingInvite()).id);
    await revokeInvite(one, String(sent.invites[0]?.id));
    await people.deactivatePerson(one, someone.id);
    await people.reactivatePerson(one, someone.id);
    await people.deactivatePerson(one, someone.id);
    await people.deletePerson(one, someone.id);
    // The other preset than the one in force, so the conventions save.
    const preset =
      (await currentConventions(deps.db)).preset === "minimal"
        ? "metrics_book"
        : "minimal";
    const imported = await importBook(one, lockedImport(preset), {
      apply: true,
    });
    expect(partsOf(imported)).toEqual(
      expect.arrayContaining(LOCKED_IMPORT_PARTS),
    );
    await makeFirstAdmin(one);
  } finally {
    await pool.end();
  }
});

it("demoting a person admin in the app revokes their open invites, though a stale admin group still names them, and leaves the group's other admins theirs", async () => {
  await person("admin");
  const demoted = await person("admin");
  // Admin only through the same stale group, which this change leaves.
  const bystander = await person("viewer");
  const group = randomUUID();
  for (const { id } of [demoted, bystander])
    await deps.db.insert(personIdentity).values({
      user_id: id,
      group_object_ids: [group],
      groups_read_at: new Date(Date.now() - 8 * DAYS),
    });
  await people.assignRole(admin, {
    role: "admin",
    subject_kind: "group",
    provider: "microsoft",
    subject: group,
  });
  const sent = (invited_by: string) => ({
    email: `${randomUUID()}@example.test`,
    role: "admin",
    token_sha256: randomBytes(32).toString("hex"),
    invited_by,
    expires_at: new Date(Date.now() + 3600_000),
  });
  const [ofDemoted, ofBystander] = await deps.db
    .insert(invite)
    .values([sent(demoted.id), sent(bystander.id)])
    .returning({ id: invite.id });
  await people.setPersonRole(admin, demoted.id, "viewer");
  const revokedBy = async (row: { id: string } | undefined) =>
    (
      await deps.db
        .select({ revoked_by: invite.revoked_by })
        .from(invite)
        .where(eq(invite.id, String(row?.id)))
    )[0]?.revoked_by;
  expect(await revokedBy(ofDemoted)).toBe(admin.principal.id);
  expect(await revokedBy(ofBystander)).toBeNull();
});

/**
 * A viewer with an open invite of `role` from the admin, and an invite that
 * viewer sent; revokes the first and answers who revoked the second, and the
 * revoke audits written for either email.
 */
async function revokeInviteOf(role: string) {
  await person("admin");
  const pending = await person("viewer");
  const invited = (email: string, invitedAs: string, invited_by: string) => ({
    email,
    role: invitedAs,
    token_sha256: randomBytes(32).toString("hex"),
    invited_by,
    expires_at: new Date(Date.now() + 3600_000),
  });
  const sent = `${randomUUID()}@example.test`;
  const [theirs, sentByThem] = await deps.db
    .insert(invite)
    .values([
      invited(pending.email, role, admin.principal.id),
      invited(sent, "viewer", pending.id),
    ])
    .returning({ id: invite.id });
  await revokeInvite(admin, String(theirs?.id));
  const [row] = await deps.db
    .select({ revoked_by: invite.revoked_by })
    .from(invite)
    .where(eq(invite.id, String(sentByThem?.id)));
  const audits = await deps.db
    .select({
      principal: auditEvent.principal_id,
      id: auditEvent.resource_id,
      detail: auditEvent.detail,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, "admin.people.invite_revoke"),
        inArray(auditEvent.resource_id, [pending.email, sent]),
      ),
    );
  return { pending, sent, revoked_by: row?.revoked_by, audits };
}

it("revoking the open admin invite that makes a user an admin revokes the invites that user sent, and audits each", async () => {
  const { pending, sent, revoked_by, audits } = await revokeInviteOf("admin");
  expect(revoked_by).toBe(admin.principal.id);
  const by = admin.principal.id;
  expect(audits).toEqual(
    expect.arrayContaining([
      { principal: by, id: pending.email, detail: { email: pending.email } },
      { principal: by, id: sent, detail: { email: sent } },
    ]),
  );
  expect(audits).toHaveLength(2);
});

it("revoking a viewer invite leaves the invites its user sent open", async () => {
  const { pending, revoked_by, audits } = await revokeInviteOf("viewer");
  expect(revoked_by).toBeNull();
  expect(audits).toEqual([
    {
      principal: admin.principal.id,
      id: pending.email,
      detail: { email: pending.email },
    },
  ]);
});

it("retains a departed owner's latest name and title and records the change", async () => {
  await person("admin");
  const owner = await person("viewer");
  const entry = await createMetric(admin, {
    name: `owned_${randomUUID().replaceAll("-", "")}`,
    label: "Owned metric",
  });
  await setTitle(admin, owner.id, "Analyst");
  await setOwner(admin, entry.id, owner.email);
  await deps.db
    .update(user)
    .set({ name: "Sample owner" })
    .where(eq(user.id, owner.id));
  await setTitle(admin, owner.id, "Finance lead");
  await people.deactivatePerson(admin, owner.id);
  expect((await getMetric(admin, entry.id)).owner_person).toMatchObject({
    name: "Sample owner",
    title: "Finance lead",
    left: true,
  });
  await expect(setOwner(admin, entry.id, owner.email)).rejects.toMatchObject({
    kind: "invalid",
  });
  await people.deletePerson(admin, owner.id);
  expect((await getMetric(admin, entry.id)).owner_person).toEqual({
    id: null,
    name: "Sample owner",
    title: "Finance lead",
    left: true,
  });
});

it("refuses another person's title without revealing whether the person exists", async () => {
  const viewer = await person("viewer");
  const other = await person("viewer");
  const context = {
    ...admin,
    principal: { ...admin.principal, id: viewer.id, roles: ["viewer"] },
  };
  for (const id of [other.id, randomUUID()]) {
    await expect(setTitle(context, id, "Changed")).rejects.toMatchObject({
      kind: "refused",
    });
  }
});
