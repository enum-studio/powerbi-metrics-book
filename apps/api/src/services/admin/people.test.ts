import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminOnRecord,
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { request, searchLog } from "../../db/schema/usage.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  oauthClient,
  oauthConsent,
  session,
  user,
} from "../../db/schema/auth.js";
import { personIdentity } from "../../db/schema/mirror.js";
import { personSignIn } from "../../db/schema/roles.js";
import {
  assignRole,
  deactivatePerson,
  deletePerson,
  hasAdmin,
  insertAssignment,
  listPeople,
  listRoleAssignments,
  revokeRole,
  reactivatePerson,
  setPersonRole,
  setPiiReader,
} from "./people.js";

afterAll(closeTestPools);

const NOW = new Date("2026-10-25T12:00:00Z");
const deps = createTestDeps({
  access: cerbosAccess(new MemorySettings()),
  settings: new MemorySettings({ "access.default_role": "viewer" }),
  clock: () => NOW,
});
const admin = {
  ...deps,
  principal: await adminOnRecord(deps, { through: "group" }),
};
const curator = { ...deps, principal: principals.curator };

async function person(email: string): Promise<string> {
  const id = randomUUID();
  await deps.db
    .insert(user)
    .values({ id, name: email, email, emailVerified: true });
  return id;
}

beforeAll(async () => {
  const ada = await person("ada@example.test");
  await deps.db.insert(session).values({
    id: randomUUID(),
    token: randomUUID(),
    userId: ada,
    sign_in_method: "microsoft",
    expiresAt: new Date(NOW.getTime() + 60_000),
    updatedAt: NOW,
  });
  // A Microsoft sign-in makes Bo a tenant member, whom access.default_role reaches.
  const bo = await person("bo@example.test");
  await deps.db
    .insert(personSignIn)
    .values({ user_id: bo, provider: "microsoft", signed_in_at: NOW });
  await assignRole(admin, {
    role: "admin",
    subject_kind: "person",
    subject: "Ada@example.test",
  });
});

describe("people and roles", () => {
  it("lists each person with their roles and where each comes from", async () => {
    const listed = await listPeople(admin);
    // The caller is an admin on record too (test/deps.ts adminOnRecord).
    expect(listed.filter((p) => p.id !== admin.principal.id)).toMatchObject([
      {
        email: "ada@example.test",
        sign_in_method: "microsoft",
        last_seen_at: NOW,
        powerbi_connection: "not_connected",
        roles: [
          {
            role: "admin",
            by_default: false,
            assignments: [
              { subject_kind: "person", subject: "ada@example.test" },
            ],
          },
        ],
      },
      {
        email: "bo@example.test",
        // No session: the sign-in on record says how and when.
        sign_in_method: "microsoft",
        last_seen_at: NOW,
        roles: [{ role: "viewer", by_default: true, assignments: [] }],
      },
    ]);
  });

  it("shows no sign-in for a person whose only sign-in a provider's removal ended", async () => {
    const di = await person("di@example.test");
    await deps.db
      .insert(personSignIn)
      .values({ user_id: di, provider: "okta", signed_in_at: new Date(0) });
    const listed = await listPeople(admin);
    expect(listed.find((p) => p.id === di)).toMatchObject({
      sign_in_method: null,
      last_seen_at: null,
    });
  });

  it.each([
    [
      "everyone_in_tenant",
      { role: "pii_reader", subject_kind: "everyone_in_tenant" },
    ],
    [
      "email_domain",
      {
        role: "pii_reader",
        subject_kind: "email_domain",
        subject: "example.test",
      },
    ],
  ] as const)(
    "refuses pii_reader to %s, whether assigned or imported",
    async (_, assignment) => {
      await expect(assignRole(admin, assignment)).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("pii_reader") as string,
      });
      await expect(
        insertAssignment(admin, assignment, {}),
      ).rejects.toMatchObject({ kind: "invalid" });
    },
  );

  it("assigns and revokes, auditing each, and names a group by a provider that is on", async () => {
    const group = await assignRole(admin, {
      role: "curator",
      subject_kind: "group",
      provider: "microsoft",
      subject: "g-1",
    });
    await expect(
      assignRole(admin, {
        role: "curator",
        subject_kind: "group",
        provider: "okta",
        subject: "g-1",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      assignRole(admin, {
        role: "curator",
        subject_kind: "group",
        provider: "microsoft",
        subject: "g-1",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect((await listRoleAssignments(admin)).map((a) => a.id)).toContain(
      group.id,
    );
    await revokeRole(admin, group.id);
    expect((await listRoleAssignments(admin)).map((a) => a.id)).not.toContain(
      group.id,
    );
    await expect(revokeRole(admin, "not-a-uuid")).rejects.toMatchObject({
      kind: "not_found",
    });
    const audits = await deps.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, group.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "admin.role.assign",
      "admin.role.revoke",
    ]);
  });

  it("refuses a role that is not shipped, unless it is said to be custom", async () => {
    const analyst = {
      role: "analyst",
      subject_kind: "email_domain",
      subject: "example.test",
    } as const;
    await expect(
      assignRole(admin, { ...analyst, role: "curater" }),
    ).rejects.toThrow(
      /not a shipped role \(viewer, curator, admin, pii_reader\).*--custom/,
    );
    await expect(assignRole(admin, analyst)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(await assignRole(admin, analyst, { custom: true })).toMatchObject(
      analyst,
    );
  });

  it("gives admin to a person or a group only, and keeps the last person's", async () => {
    for (const wide of [
      { role: "admin", subject_kind: "everyone_in_tenant" },
      { role: "admin", subject_kind: "email_domain", subject: "example.test" },
    ] as const)
      await expect(assignRole(admin, wide)).rejects.toThrow(
        /person or a group only/,
      );
    const ada = (await listRoleAssignments(admin)).find(
      (a) => a.role === "admin" && a.subject === "ada@example.test",
    );
    if (ada === undefined) throw new Error("Ada is assigned admin above");
    // A group's admin may reach nobody who can sign in, so it does not count.
    const group = { subject_kind: "group", provider: "microsoft" } as const;
    await assignRole(admin, { role: "admin", ...group, subject: "g-admins" });
    await expect(revokeRole(admin, ada.id)).rejects.toMatchObject({
      kind: "conflict",
    });
    const cy = await assignRole(admin, {
      role: "admin",
      subject_kind: "person",
      subject: "cy@example.test",
    });
    const both = await Promise.allSettled([
      revokeRole(admin, ada.id),
      revokeRole(admin, cy.id),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await hasAdmin(deps.db)).toBe(true);
  });

  it("refuses a curator every function", async () => {
    for (const call of [
      () => listPeople(curator),
      () => listRoleAssignments(curator),
      () =>
        assignRole(curator, {
          role: "admin",
          subject_kind: "person",
          subject: "x@example.test",
        }),
      () => revokeRole(curator, randomUUID()),
    ])
      await expect(call()).rejects.toMatchObject({ kind: "refused" });
  });

  it("lists each person's MCP and CLI grants, and no grant of anyone else", async () => {
    const cy = await person("cy@example.test");
    const clientId = `client-${randomUUID()}`;
    await deps.db.insert(oauthClient).values({
      id: randomUUID(),
      clientId,
      name: "Sample client",
      redirectUris: ["https://client.example.test/callback"],
      createdAt: NOW,
    });
    const id = randomUUID();
    await deps.db.insert(oauthConsent).values({
      id,
      clientId,
      userId: cy,
      scopes: ["book:read"],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const people = await listPeople(admin);
    expect(people.find((p) => p.email === "cy@example.test")?.grants).toEqual([
      {
        id,
        client_id: clientId,
        client_name: "Sample client",
        via: "mcp",
        scopes: ["book:read"],
        granted_at: NOW.toISOString(),
        last_used_at: null,
      },
    ]);
    expect(people.find((p) => p.email === "ada@example.test")?.grants).toEqual(
      [],
    );
    await expect(listPeople(curator)).rejects.toMatchObject({
      kind: "refused",
    });
  });
  it("reactivates people, changes roles and PII, and deletes deactivated people", async () => {
    const email = "lifecycle@example.test";
    const id = await person(email);
    await deps.db.insert(personIdentity).values({ user_id: id });
    await assignRole(admin, {
      role: "viewer",
      subject_kind: "person",
      subject: email,
    });
    await setPiiReader(admin, id, true);
    const assignments = () =>
      listRoleAssignments(admin).then((rows) =>
        rows.filter((a) => a.subject_kind === "person" && a.subject === email),
      );
    const pii = (await assignments()).find((a) => a.role === "pii_reader");
    expect(pii).toBeDefined();
    if (pii === undefined)
      throw new Error("PII reader assignment was not added");
    await setPersonRole(admin, id, "curator");
    expect((await assignments()).map((a) => a.role).sort()).toEqual([
      "curator",
      "pii_reader",
    ]);
    expect(await assignments()).toContainEqual(pii);
    await setPiiReader(admin, id, false);
    expect((await assignments()).map((a) => a.role)).toEqual(["curator"]);
    const piiAudits = await deps.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, pii.id));
    expect(piiAudits.map((a) => a.action).sort()).toEqual([
      "admin.role.assign",
      "admin.role.revoke",
    ]);
    await deactivatePerson(admin, id);
    expect((await listPeople(admin)).find((p) => p.id === id)).toMatchObject({
      status: "deactivated",
      deactivated_at: NOW,
      direct_role: "curator",
      roles: [{ role: "curator", by_default: false }],
    });
    await reactivatePerson(admin, id);
    expect((await listPeople(admin)).find((p) => p.id === id)).toMatchObject({
      status: "active",
      deactivated_at: null,
      direct_role: "curator",
    });
    await expect(reactivatePerson(admin, id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await deactivatePerson(admin, id);
    expect(
      await deps.db
        .select()
        .from(personIdentity)
        .where(eq(personIdentity.user_id, id)),
    ).toHaveLength(1);
    expect(await assignments()).toHaveLength(1);
    await deletePerson(admin, id);
    expect((await listPeople(admin)).some((p) => p.id === id)).toBe(false);
    expect(
      await deps.db
        .select()
        .from(personIdentity)
        .where(eq(personIdentity.user_id, id)),
    ).toEqual([]);
    expect(await assignments()).toEqual([]);
    const audits = await deps.db
      .select({ action: auditEvent.action, detail: auditEvent.detail })
      .from(auditEvent)
      .where(eq(auditEvent.resource_id, id));
    expect(audits).toEqual(
      expect.arrayContaining([
        {
          action: "admin.role.change",
          detail: { email, from: "viewer", to: "curator" },
        },
        { action: "admin.people.deactivate", detail: { email } },
        { action: "admin.people.reactivate", detail: { email } },
        { action: "admin.people.delete", detail: { email } },
      ]),
    );
    expect(audits).toHaveLength(5);
  });

  it("says where PII comes from, and lists a deactivated person's assignments", async () => {
    const group = randomUUID();
    const pia = await person("pia@example.test");
    await deps.db.insert(personIdentity).values({
      user_id: pia,
      group_object_ids: [group],
      groups_read_at: NOW,
    });
    await assignRole(admin, {
      role: "pii_reader",
      subject_kind: "group",
      provider: "microsoft",
      subject: group,
    });
    const dee = await person("dee@example.test");
    await deps.db
      .insert(personSignIn)
      .values({ user_id: dee, provider: "microsoft", signed_in_at: NOW });
    await setPersonRole(admin, dee, "curator");
    await setPiiReader(admin, dee, true);
    const tenant = await assignRole(admin, {
      role: "viewer",
      subject_kind: "everyone_in_tenant",
    });
    await deactivatePerson(admin, dee);
    const listed = await listPeople(admin);
    const of = (email: string) => listed.find((p) => p.email === email);
    expect(of("ada@example.test")?.pii_reader).toEqual({
      source: "none",
      assignments: [],
    });
    expect(of("pia@example.test")?.pii_reader).toMatchObject({
      source: "inherited",
      assignments: [{ subject_kind: "group", subject: group }],
    });
    expect(of("dee@example.test")).toMatchObject({
      status: "deactivated",
      direct_role: "curator",
      pii_reader: {
        source: "direct",
        assignments: [{ subject_kind: "person", subject: "dee@example.test" }],
      },
      roles: [
        {
          role: "curator",
          by_default: false,
          assignments: [{ subject_kind: "person" }],
        },
        { role: "pii_reader", by_default: false },
        {
          role: "viewer",
          by_default: false,
          assignments: [{ id: tenant.id, subject_kind: "everyone_in_tenant" }],
        },
      ],
    });
    await revokeRole(admin, tenant.id);
  });

  it("lists the default role a deactivated tenant member gets back on Reactivate", async () => {
    const dot = await person("dot@example.test");
    await deps.db
      .insert(personSignIn)
      .values({ user_id: dot, provider: "microsoft", signed_in_at: NOW });
    await deactivatePerson(admin, dot);
    const listed = await listPeople(admin);
    expect(listed.find((p) => p.email === "dot@example.test")).toMatchObject({
      status: "deactivated",
      roles: [{ role: "viewer", by_default: true, assignments: [] }],
    });
  });
});

it("deletes a person's usage rows and preserves other principals", async () => {
  const owner = await person(`usage-${randomUUID()}@example.test`);
  const other = await person(`usage-other-${randomUUID()}@example.test`);
  const ids = [];
  for (const principal of [
    { principal_kind: "person" as const, principal_id: owner },
    { principal_kind: "person" as const, principal_id: other },
    { principal_kind: "service_account" as const, principal_id: owner },
  ]) {
    const row = {
      id: randomUUID(),
      at: deps.clock(),
      via: "mcp" as const,
      ...principal,
    };
    ids.push(row.id);
    await deps.auditDb
      .insert(request)
      .values({ ...row, question: "Sample question", outcome: "answered" });
    await deps.auditDb.insert(searchLog).values({
      ...row,
      query: "Sample search",
      search_mode: "words_only",
      hit_count: 0,
      metric_hit: false,
    });
  }
  await deactivatePerson(admin, owner);
  await deletePerson(admin, owner);
  for (const table of [request, searchLog]) {
    expect(
      await deps.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, ids[0] ?? "")),
    ).toEqual([]);
    for (const id of ids.slice(1)) {
      expect(
        await deps.db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.id, id)),
      ).toHaveLength(1);
      await deps.db.delete(table).where(eq(table.id, id));
    }
  }
});
