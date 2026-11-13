import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inRolledBack } from "../../../test/db-roles.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  assignRole,
  listAssignments,
  resolveRoles,
  revokeRole,
} from "./roles.js";

afterAll(closeTestPools);

const run = randomUUID().slice(0, 8);
const domain = `roles-${run}.example.test`;
const settings = new MemorySettings({ "access.default_role": "viewer" });
const outsider = {
  email: `someone@${domain}`,
  email_verified: true,
  domain_verified: true,
  groups: [],
  tenant_member: false,
  deactivated: false,
  open_invite_role: null,
};
const member = { ...outsider, tenant_member: true };

// Rolled back, so an assignment for everyone in the tenant never reaches another test file.
const inTenant = <T>(work: Parameters<typeof inRolledBack<T>>[1]) =>
  inRolledBack("api_rw", work);

describe("resolveRoles", () => {
  it("matches a verified email in any case, its domain, and a group at its provider", () =>
    inTenant(async (db) => {
      await assignRole(
        db,
        {
          role: "curator",
          subject_kind: "person",
          subject: `Someone@${domain.toUpperCase()}`,
        },
        principals.admin,
      );
      await assignRole(
        db,
        { role: "viewer", subject_kind: "email_domain", subject: domain },
        principals.admin,
      );
      await assignRole(
        db,
        {
          role: "admin",
          subject_kind: "group",
          provider: "sample_oidc",
          subject: `group-${run}`,
        },
        principals.admin,
      );
      expect(await resolveRoles({ db, settings }, outsider)).toEqual([
        "curator",
        "viewer",
      ]);
      const inGroup = {
        ...outsider,
        groups: [{ provider: "sample_oidc", id: `group-${run}` }],
      };
      expect(await resolveRoles({ db, settings }, inGroup)).toEqual([
        "admin",
        "curator",
        "viewer",
      ]);
    }));

  it("gives a tenant member the default role only when nothing else reaches them, and nobody else", () =>
    inTenant(async (db) => {
      expect(await resolveRoles({ db, settings }, member)).toEqual(["viewer"]);
      expect(await resolveRoles({ db, settings }, outsider)).toEqual([]);
      await assignRole(
        db,
        { role: "curator", subject_kind: "everyone_in_tenant" },
        principals.admin,
      );
      expect(await resolveRoles({ db, settings }, member)).toEqual(["curator"]);
      expect(await resolveRoles({ db, settings }, outsider)).toEqual([]);
    }));

  it("gives no default role when access.default_role is none", () =>
    inTenant(async (db) => {
      const none = new MemorySettings({ "access.default_role": "none" });
      expect(await resolveRoles({ db, settings: none }, member)).toEqual([]);
    }));

  it("gives a deactivated person no role, not even the default role", () =>
    inTenant(async (db) => {
      const deactivated = { ...member, deactivated: true };
      expect(await resolveRoles({ db, settings }, deactivated)).toEqual([]);
    }));

  it("adds an open invite's role as a person assignment would, in place of the default role", () =>
    inTenant(async (db) => {
      await assignRole(
        db,
        { role: "viewer", subject_kind: "email_domain", subject: domain },
        principals.admin,
      );
      const invited = { ...member, open_invite_role: "curator" };
      expect(await resolveRoles({ db, settings }, invited)).toEqual([
        "curator",
        "viewer",
      ]);
      expect(
        await resolveRoles(
          { db, settings },
          { ...invited, domain_verified: false },
        ),
      ).toEqual(["curator"]);
    }));
});

describe("assignments", () => {
  it("lists, revokes, and says when there is nothing to revoke", () =>
    inTenant(async (db) => {
      const made = await assignRole(
        db,
        { role: "viewer", subject_kind: "email_domain", subject: domain },
        principals.admin,
      );
      expect((await listAssignments(db)).map((a) => a.id)).toContain(made.id);
      await revokeRole(db, made.id);
      expect((await listAssignments(db)).map((a) => a.id)).not.toContain(
        made.id,
      );
      await expect(revokeRole(db, made.id)).rejects.toMatchObject({
        kind: "not_found",
      });
    }));
});
