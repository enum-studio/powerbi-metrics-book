import { afterAll, describe, expect, it } from "vitest";
import type { Resource } from "../../context.js";
import type { Principal } from "../../principal.js";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { adminStatus } from "../admin/status.js";

/*
 * A service account never administers and never edits the conventions,
 * whatever role it holds or a policy grants: the bound is code in
 * createAccess, ahead of Cerbos. Both the shipped admin role and a role a
 * deployment's override policy grants admin:* are refused. The one admin
 * action left to the policies is read_status, the status page.
 */

afterAll(closeTestPools);

const access = cerbosAccess(new MemorySettings());
const adminRole: Principal = principals.admin;
const serviceAccount: Principal = {
  ...adminRole,
  kind: "service_account",
  id: "sa_admin",
  via: "api",
};

const ADMIN_ACTIONS = [
  "manage_settings",
  "manage_secrets",
  "manage_people",
  "manage_service_accounts",
  "run_sync",
  "read_audit",
  "revoke_connection",
  "sign_out_person",
  "run_check",
  "export_book",
  "import_book",
];
const admin: Resource = { kind: "admin", id: "admin", attr: {} };
const book: Resource = { kind: "book", id: "book", attr: {} };

describe("a service account's bound", () => {
  it.each(ADMIN_ACTIONS)(
    "refuses admin:%s to a service account the policies would allow",
    async (action) => {
      expect(await access.check(adminRole, admin, action)).toBe(true);
      expect(await access.check(serviceAccount, admin, action)).toBe(false);
      await expect(
        access.require(serviceAccount, admin, action),
      ).rejects.toMatchObject({ kind: "refused" });
    },
  );

  it("refuses book:edit_conventions, and leaves its other book actions to the policies", async () => {
    expect(await access.check(adminRole, book, "edit_conventions")).toBe(true);
    expect(await access.check(serviceAccount, book, "edit_conventions")).toBe(
      false,
    );
    expect(await access.check(serviceAccount, book, "curate")).toBe(true);
  });

  it.each(ADMIN_ACTIONS)(
    "refuses admin:%s under a deployment policy that grants the account's role admin:*",
    async (action) => {
      // access/layering_tests/override/policies/admin.yaml grants integration admin:*.
      const overridden = cerbosAccess(new MemorySettings(), "override");
      const roles = ["integration"];
      const person = { ...principals.viewer, roles };
      expect(await overridden.check(person, admin, action)).toBe(true);
      expect(
        await overridden.check({ ...serviceAccount, roles }, admin, action),
      ).toBe(false);
    },
  );

  it("lets a service account read the admin status when a policy gives its role read_status", async () => {
    const overridden = cerbosAccess(new MemorySettings(), "override");
    const account = { ...serviceAccount, roles: ["integration"] };
    const status = await adminStatus({
      ...createTestDeps({ access: overridden }),
      principal: account,
    });
    expect(status.last_sync).toBeNull();
    for (const check of status.failing_checks)
      expect(Object.keys(check)).toEqual(["name"]);
    expect(status).not.toHaveProperty("people_to_reconnect");
    expect(await access.check(account, admin, "read_status")).toBe(false);
  });
});
