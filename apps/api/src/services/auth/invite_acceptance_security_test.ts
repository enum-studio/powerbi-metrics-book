import { randomBytes } from "node:crypto";
import type { Person } from "@powerbi-metrics-book/powerbi-mock";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import {
  adminOnRecord,
  cerbosAccess,
  closeTestPools,
  principals,
} from "../../../test/deps.js";
import {
  type SignInFixture,
  startSignIn,
  UNVERIFIED_OIDC,
} from "../../../test/sign-in-support.js";
import { migrateDatabase } from "../../db/migrate.js";
import type { Principal } from "../../principal.js";
import { auditEvent } from "../../db/schema/audit.js";
import { invite } from "../../db/schema/invites.js";
import { roleAssignment } from "../../db/schema/roles.js";
import { invitePeople, revokeInvite } from "./invites.js";
import { MICROSOFT } from "./roles.js";

let f: SignInFixture;

beforeAll(async () => {
  f = await startSignIn();
  // As setup stores it on a new deployment: only an invite can admit these people.
  await f.deps.settings.set("access.default_role", "none", principals.admin);
});

afterAll(() => Promise.all([f.close(), closeTestPools()]));

const NONE = { accepted: { at: null, by: null }, granted: [] };

const invited = (who: Person, closed: Partial<typeof invite.$inferInsert>) =>
  f.deps.db.insert(invite).values({
    email: who.email,
    role: "curator",
    token_sha256: randomBytes(32).toString("hex"),
    delivery: "email",
    invited_by: principals.admin.id,
    last_sent_at: new Date(),
    expires_at: new Date(Date.now() + 3600_000),
    ...closed,
  });

const errorOf = async (who: Person, provider: string) =>
  new URL(
    String((await f.signIn(who, provider)).callback.headers.get("location")),
    "https://x.test",
  ).searchParams.get("error");

async function state(who: Person) {
  const [accepted] = await f.deps.db
    .select({ at: invite.accepted_at, by: invite.accepted_user_id })
    .from(invite)
    .where(eq(invite.email, who.email));
  const r = roleAssignment;
  const granted = await f.deps.db
    .select({ kind: r.subject_kind, role: r.role, by: r.granted_by })
    .from(r)
    .where(eq(r.subject, who.email));
  return { accepted, granted };
}

describe("an invite at sign-in", () => {
  it.each([
    ["an expired invite", "analyst", MICROSOFT, { expires_at: new Date(0) }],
    ["a revoked invite", "leader", MICROSOFT, { revoked_at: new Date() }],
    ["an invite to an unverified email", "app-reader", UNVERIFIED_OIDC, {}],
  ])("admits nobody with %s", async (_, mailbox, provider, closed) => {
    const who = f.person(mailbox);
    await invited(who, closed);
    expect(await errorOf(who, provider)).toBe("not_assigned");
    expect(await state(who)).toEqual(NONE);
  });

  it("writes one person assignment granted by the inviter, and only once", async () => {
    const who = f.person("viewer");
    await invited(who, {});
    expect(await errorOf(who, MICROSOFT)).toBeNull();
    const first = await state(who);
    expect(first.accepted?.by).toBe(await f.userId(who.email));
    expect(first.granted).toEqual([
      { kind: "person", role: "curator", by: principals.admin.id },
    ]);
    expect(await errorOf(who, MICROSOFT)).toBeNull();
    expect(await state(who)).toEqual(first);
    const audit = await f.deps.db
      .select({ principal_id: auditEvent.principal_id })
      .from(auditEvent)
      .where(
        sql`${auditEvent.action} = 'people.invite_accept' and ${auditEvent.resource_id} = ${who.email}`,
      );
    expect(audit).toEqual([{ principal_id: await f.userId(who.email) }]);
  });

  it("accepts an invite without duplicating an equal person assignment", async () => {
    const who = f.person("admin");
    await f.deps.db.insert(roleAssignment).values({
      role: "curator",
      subject_kind: "person",
      subject: who.email,
      granted_by: principals.admin.id,
    });
    const before = await state(who);
    await invited(who, {});
    expect(await errorOf(who, MICROSOFT)).toBeNull();
    const accepted = await state(who);
    expect(accepted.accepted?.at).toBeInstanceOf(Date);
    expect(accepted.accepted?.by).toBe(await f.userId(who.email));
    expect(accepted.granted).toEqual(before.granted);
  });
});

describe("an invite sent before invites held the role", () => {
  const admin = (principal: Principal) => ({
    ...f.deps,
    access: cerbosAccess(f.deps.settings),
    principal,
  });
  it.each([
    ["revoked", "outsider", false],
    ["invited again by another admin, then revoked", "sales-viewer", true],
  ])(
    "loses the assignment its sending made at the next start, and admits nobody once %s",
    async (_, mailbox, again) => {
      const who = f.person(mailbox);
      const sent = new Date(Date.now() - 86400_000);
      // Only an invite made before 0003 has no last_sent_at.
      await invited(who, { created_at: sent, last_sent_at: null });
      // As sending did then: the role assigned to the email at once, by the inviter.
      await f.deps.db.insert(roleAssignment).values({
        role: "curator",
        subject_kind: "person",
        subject: who.email,
        granted_by: principals.admin.id,
        granted_at: new Date(sent.getTime() + 40),
      });
      await migrateDatabase(roleUrl("migrator"));
      if (again)
        await invitePeople(admin(await adminOnRecord(f.deps)), {
          emails: [who.email],
          role: "viewer",
          delivery: "link",
        });
      const [row] = await f.deps.db
        .select({ id: invite.id })
        .from(invite)
        .where(eq(invite.email, who.email));
      await revokeInvite(admin(await adminOnRecord(f.deps)), String(row?.id));
      expect(await errorOf(who, MICROSOFT)).toBe("not_assigned");
      expect(await state(who)).toEqual(NONE);
    },
  );
});
