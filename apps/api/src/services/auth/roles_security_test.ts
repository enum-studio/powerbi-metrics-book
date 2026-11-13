import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asRole, inRolledBack } from "../../../test/db-roles.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personSignIn } from "../../db/schema/roles.js";
import {
  assignRole,
  MICROSOFT,
  resolveRoles,
  roleSubject,
  SIGN_IN_FRESH_MS,
} from "./roles.js";

/*
 * What may reach a role: only a verified email, a group only at the provider
 * that named it, and groups only while the sign-in that read them is recent.
 * Each case runs in a transaction that is rolled back.
 */

afterAll(closeTestPools);

const run = randomUUID().slice(0, 8);
const settings = new MemorySettings();
const email = `person-${run}@roles-${run}.example.test`;
const group = randomUUID();
const now = new Date("2026-10-25T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

async function person(db: Db): Promise<string> {
  const id = `user-${run}`;
  await db.insert(user).values({ id, name: "Person", email });
  return id;
}

describe("whose email counts", () => {
  it("matches a person only by a verified email, and a domain only when a sign-in vouched for it", () =>
    inRolledBack("api_rw", async (db) => {
      await assignRole(
        db,
        { role: "curator", subject_kind: "person", subject: email },
        principals.admin,
      );
      await assignRole(
        db,
        {
          role: "viewer",
          subject_kind: "email_domain",
          subject: email.split("@")[1] ?? "",
        },
        principals.admin,
      );
      const roles = (email_verified: boolean, domain_verified: boolean) =>
        resolveRoles(
          { db, settings },
          {
            email,
            email_verified,
            domain_verified,
            groups: [],
            tenant_member: false,
            deactivated: false,
            open_invite_role: null,
          },
        );
      expect(await roles(true, true)).toEqual(["curator", "viewer"]);
      expect(await roles(true, false)).toEqual(["curator"]);
      expect(await roles(false, true)).toEqual([]);
    }));
});

describe("whose groups count", () => {
  it("matches a group only at the provider that named it", () =>
    inRolledBack("api_rw", async (db) => {
      await assignRole(
        db,
        {
          role: "curator",
          subject_kind: "group",
          provider: MICROSOFT,
          subject: group,
        },
        principals.admin,
      );
      const who = (provider: string) => ({
        email,
        email_verified: true,
        domain_verified: true,
        groups: [{ provider, id: group }],
        tenant_member: false,
        deactivated: false,
        open_invite_role: null,
      });
      expect(await resolveRoles({ db, settings }, who(MICROSOFT))).toEqual([
        "curator",
      ]);
      expect(await resolveRoles({ db, settings }, who("sample_oidc"))).toEqual(
        [],
      );
    }));

  it("ignores the groups and vouched domain of a sign-in, or an Entra read, more than 7 days old", () =>
    inRolledBack("api_rw", async (db) => {
      const id = await person(db);
      const fresh = daysAgo(6);
      const stale = new Date(now.getTime() - SIGN_IN_FRESH_MS - 1000);
      await db.insert(personSignIn).values([
        {
          user_id: id,
          provider: "fresh_oidc",
          signed_in_at: fresh,
          group_ids: ["a"],
        },
        {
          user_id: id,
          provider: "stale_oidc",
          signed_in_at: stale,
          group_ids: ["b"],
          domain_verified: true,
        },
      ]);
      await db.insert(personIdentity).values({
        user_id: id,
        microsoft_object_id: randomUUID(),
        group_object_ids: [group],
        groups_read_at: stale,
      });
      const subject = await roleSubject(
        db,
        { id, email, email_verified: true },
        now,
      );
      expect(subject.groups).toEqual([{ provider: "fresh_oidc", id: "a" }]);
      expect(subject.domain_verified).toBe(false);
      // Tenant membership is only as fresh as the Entra read behind it.
      expect(subject.tenant_member).toBe(false);
    }));
});

describe("the database", () => {
  it.each([
    ["role none", "none", "person", "a@b.c", null],
    ["a subject for everyone", "viewer", "everyone_in_tenant", "a", null],
    ["an email in upper case", "viewer", "person", "A@b.c", null],
    ["an unknown kind", "viewer", "team", "a", null],
    ["a group with no provider", "viewer", "group", "g", null],
    ["a provider on a person", "viewer", "person", "a@b.c", "microsoft"],
  ])(
    "refuses an assignment with %s",
    async (_, role, kind, subject, provider) => {
      const insert =
        "insert into role_assignment (role, subject_kind, subject, provider, granted_by) values ($1, $2, $3, $4, 'x')";
      await expect(
        asRole("api_rw", insert, [role, kind, subject, provider]),
      ).rejects.toThrow(/violates check constraint/);
    },
  );

  it.each([
    ["admin", "everyone_in_tenant", null],
    ["admin", "email_domain", "b.c"],
    ["pii_reader", "everyone_in_tenant", null],
    ["pii_reader", "email_domain", "b.c"],
  ])(
    "refuses %s to %s, whatever the api checked",
    async (role, kind, subject) => {
      const insert =
        "insert into role_assignment (role, subject_kind, subject, granted_by) values ($1, $2, $3, 'x')";
      await expect(
        asRole("api_rw", insert, [role, kind, subject]),
      ).rejects.toThrow(/role_assignment_privileged_subject/);
    },
  );

  it("is not the worker's to read", async () => {
    for (const table of ["role_assignment", "person_sign_in"])
      await expect(
        asRole("worker_rw", `select * from ${table}`),
      ).rejects.toThrow(/permission denied/);
  });
});
