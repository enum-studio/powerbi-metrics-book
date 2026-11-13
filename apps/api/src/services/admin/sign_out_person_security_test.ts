import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  adminOnRecord,
  cerbosAccess,
  closeTestPools,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { fromSpa, startOAuth } from "../../../test/sign-in-support.js";
import type { ServiceContext } from "../../context.js";
import { auditEvent } from "../../db/schema/audit.js";
import { oauthConsent, session } from "../../db/schema/auth.js";
import { personDeactivation } from "../../db/schema/people.js";
import { listRoleAssignments, signOutPerson } from "./people.js";

/*
 * An admin's Sign out for a person ends every browser session of theirs and
 * every MCP and CLI grant, so they must sign in again everywhere, and leaves
 * them active with their roles. Only an admin may, and not on themselves.
 */

afterAll(closeTestPools);

describe("an admin signing a person out", () => {
  const o = startOAuth({ access: cerbosAccess(new MemorySettings()) });
  const me = (cookie: string) =>
    o.request("/api/v1/me", { headers: { cookie } });
  const as = (principal: ServiceContext["principal"]): ServiceContext => ({
    ...o.deps,
    principal,
  });

  it("ends their sessions and tokens, keeps their roles, and lets them sign in again", async () => {
    const admin = as(await adminOnRecord(o.deps));
    const person = await o.person();
    const mcp = await o.connect(person.cookie, o.client());
    const cli = await o.login(person.cookie);
    const assignments = await listRoleAssignments(admin);
    await signOutPerson(admin, person.id);
    expect((await me(person.cookie)).status).toBe(401);
    expect((await o.whoami(mcp.access_token)).status).toBe(401);
    expect((await o.bearer("/api/v1/me", cli.access_token)).status).toBe(401);
    const refreshed = await o.token({
      grant_type: "refresh_token",
      refresh_token: cli.refresh_token,
      client_id: "pbmb-cli",
    });
    expect(refreshed.status).not.toBe(200);
    expect(
      await o.deps.db
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.userId, person.id)),
    ).toEqual([]);
    expect(
      await o.deps.db
        .select()
        .from(personDeactivation)
        .where(eq(personDeactivation.user_id, person.id)),
    ).toEqual([]);
    expect(await listRoleAssignments(admin)).toEqual(assignments);
    const [audit] = await o.deps.db
      .select({ actor: auditEvent.principal_id, detail: auditEvent.detail })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, "admin.people.sign_out"),
          eq(auditEvent.resource_id, person.id),
        ),
      )
      .orderBy(desc(auditEvent.id))
      .limit(1);
    expect(audit).toEqual({
      actor: admin.principal.id,
      detail: { email: person.email },
    });
    const again = await o.request(
      "/api/auth/dev/sign-in",
      fromSpa("", { email: person.email }),
    );
    expect(again.status).toBe(200);
    const signedIn = await me(again.headers.getSetCookie().join("; "));
    expect(signedIn.status).toBe(200);
  });

  it("refuses a person who is not an admin, and ends nothing", async () => {
    const person = await o.person();
    const viewer = await o.person();
    await expect(
      signOutPerson(as({ ...principals.viewer, id: viewer.id }), person.id),
    ).rejects.toMatchObject({ kind: "refused" });
    const answer = await o.request(
      `/api/v1/admin/people/${person.id}/sign-out`,
      fromSpa(viewer.cookie, {}),
    );
    expect(answer.status).toBe(403);
    expect((await me(person.cookie)).status).toBe(200);
  });

  it("refuses an admin signing themselves out here", async () => {
    const principal = await adminOnRecord(o.deps);
    await o.deps.db.insert(session).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId: principal.id,
      sign_in_method: "microsoft",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      signOutPerson(as(principal), principal.id),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(
      await o.deps.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, principal.id)),
    ).toHaveLength(1);
  });

  it("answers a person who does not exist as not found", async () => {
    const admin = as(await adminOnRecord(o.deps));
    await expect(
      signOutPerson(admin, crypto.randomUUID()),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});
