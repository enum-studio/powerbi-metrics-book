import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inRolledBack } from "../../../test/db-roles.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import {
  joined,
  type SetupFixture,
  startSetup,
} from "../../../test/setup-support.js";
import {
  cookies,
  startOAuth,
  startSignIn,
} from "../../../test/sign-in-support.js";
import type { Db } from "../../context.js";
import { account, user } from "../../db/schema/auth.js";
import { invite } from "../../db/schema/invites.js";
import { personDeactivation } from "../../db/schema/people.js";
import { personSignIn } from "../../db/schema/roles.js";
import { hasAdmin } from "../admin/people.js";
import { setupLink } from "../../db/schema/setup.js";
import * as setupLinks from "../setup/link.js";
import * as roleChecks from "./roles.js";
import {
  type Assignment,
  assignRole,
  MICROSOFT,
  resolveRoles,
  roleSubject,
} from "./roles.js";

/*
 * Deactivation beats every way a role reaches a person, and every way in:
 * Microsoft sign-in, a session, an MCP token and a CLI token. A deactivated
 * admin, or one whose stored email is unverified, counts as no admin.
 */

afterAll(closeTestPools);

const DOMAIN = "deactivation.example.test";
const GROUP = `group-${randomUUID()}`;
const deactivate = (db: Db, user_id: string) =>
  db
    .insert(personDeactivation)
    .values({ user_id, deactivated_by: principals.admin.id });

async function addUser(db: Db, email: string, verified = true) {
  const id = randomUUID();
  await db
    .insert(user)
    .values({ id, email, name: email, emailVerified: verified });
  return { id, email, email_verified: verified };
}

const email = `person@${DOMAIN}`;
const reaches: [string, Assignment | "invite" | null][] = [
  ["everyone_in_tenant with default role viewer", null],
  [
    "a group",
    {
      role: "viewer",
      subject_kind: "group",
      provider: "sample_oidc",
      subject: GROUP,
    },
  ],
  [
    "an email domain",
    { role: "viewer", subject_kind: "email_domain", subject: DOMAIN },
  ],
  [
    "a person assignment",
    { role: "viewer", subject_kind: "person", subject: email },
  ],
  ["an open invite", "invite"],
];

describe("whom deactivation refuses", () => {
  it.each(reaches)(
    "gives no role to a deactivated person reached by %s",
    (_, reach) =>
      inRolledBack("api_rw", async (db) => {
        const person = await addUser(db, email);
        const fresh = {
          user_id: person.id,
          signed_in_at: new Date(),
          domain_verified: true,
        };
        await db.insert(personSignIn).values([
          { ...fresh, provider: MICROSOFT, group_ids: null },
          { ...fresh, provider: "sample_oidc", group_ids: [GROUP] },
        ]);
        if (reach === "invite")
          await db.insert(invite).values({
            email,
            role: "viewer",
            token_sha256: randomBytes(32).toString("hex"),
            delivery: "email",
            invited_by: principals.admin.id,
            last_sent_at: new Date(),
            expires_at: new Date(Date.now() + 3600_000),
          });
        else if (reach !== null) await assignRole(db, reach, principals.admin);
        const settings = new MemorySettings({
          "access.default_role": reach === null ? "viewer" : "none",
        });
        const roles = async () =>
          resolveRoles(
            { db, settings },
            await roleSubject(db, person, new Date()),
          );
        expect(await roles()).toEqual(["viewer"]);
        await deactivate(db, person.id);
        expect(await roles()).toEqual([]);
      }),
  );
});

describe("every way in", () => {
  it("refuses a deactivated person's session and their Microsoft sign-in", async () => {
    const f = await startSignIn();
    await f.settings.set("access.default_role", "viewer");
    const who = f.person("analyst");
    const { cookie } = await f.signIn(who, MICROSOFT);
    const me = () => f.request("/api/v1/me", { headers: { cookie } });
    expect((await me()).status).toBe(200);
    await deactivate(f.deps.db, await f.userId(who.email));
    expect((await me()).status).toBe(403);
    const again = (await f.signIn(who, MICROSOFT)).callback.headers.get(
      "location",
    );
    expect(
      new URL(String(again), "https://x.test").searchParams.get("error"),
    ).toBe("deactivated");
    await f.close();
  });

  it("refuses a deactivated person's MCP and CLI tokens", async () => {
    const o = startOAuth();
    const person = await o.person();
    const mcp = await o.connect(person.cookie, o.client());
    const cli = await o.login(person.cookie);
    expect((await o.whoami(mcp.access_token)).status).toBe(200);
    expect((await o.bearer("/api/v1/me", cli.access_token)).status).toBe(200);
    await deactivate(o.deps.db, person.id);
    expect((await o.whoami(mcp.access_token)).status).toBe(403);
    expect((await o.bearer("/api/v1/me", cli.access_token)).status).toBe(403);
  });
});

describe("the setup's one Microsoft sign-in", () => {
  // One fixture for both cases: the app registration's secret is encrypted
  // to its api's identity, which a second fixture would not hold.
  let f: SetupFixture;
  beforeAll(async () => {
    f = await startSetup();
  });
  afterAll(() => f.close());

  it.each(["callback", "session"])("refuses setup at %s", async (gate) => {
    const open = vi.spyOn(setupLinks, "setupSignInOpen");
    const spend = vi.spyOn(setupLinks, "spendSetupSignIn");
    const original = roleChecks.roleSubject;
    const subject = vi.spyOn(roleChecks, "roleSubject");
    try {
      const who = {
        ...f.person("admin"),
        object_id: randomUUID(),
        email: `${randomUUID()}@sample.example`,
      };
      f.tenant.people.push(who);
      const person = await addUser(f.api.db, who.email);
      await f.api.db.insert(account).values({
        id: randomUUID(),
        accountId: who.object_id,
        providerId: MICROSOFT,
        userId: person.id,
      });
      await deactivate(f.api.db, person.id);
      await f.api.db.delete(setupLink);
      const session = await f.openSession();
      const sample = f.tenant.apps_registrations[0];
      const registered = await f.post(
        "/api/setup/steps/app_registration",
        session,
        {
          settings: {
            "powerbi.tenant_id": f.tenant.tenant_id,
            "powerbi.app_client_id": sample?.client_id,
          },
          secrets: {
            powerbi_app_client_secret: {
              value: sample?.secret,
              expires_at: null,
            },
          },
        },
      );
      expect(registered.status).toBe(200);
      const cookie = joined(session, cookies(registered));
      const started = await f.startSignIn(cookie);
      const before = await f.api.db.select().from(setupLink);
      if (gate === "session") {
        subject.mockImplementationOnce(async (...args) => ({
          ...(await original(...args)),
          deactivated: false,
        }));
      }
      const callback = await f.finishSignIn(
        who,
        started.url,
        joined(cookie, started.cookie),
      );
      expect(callback.headers.get("location")).toContain("error=deactivated");
      if (gate === "callback") expect(open).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
      expect(await f.api.db.select().from(setupLink)).toEqual(before);
      const next = await f.signIn(f.person("analyst"), cookie);
      expect(next.callback.headers.get("location")).toBe("/setup");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("who counts as an admin", () => {
  it("counts no deactivated admin and no unverified email, but an email no user holds yet", () =>
    inRolledBack("api_rw", async (db) => {
      const admitted = async () => {
        const { rows } = await db.execute<{ has: boolean }>(
          sql`select deployment_has_admin() as has`,
        );
        expect(rows[0]?.has).toBe(await hasAdmin(db));
        return rows[0]?.has;
      };
      const admin = (subject: string) =>
        assignRole(
          db,
          { role: "admin", subject_kind: "person", subject },
          principals.admin,
        );
      const gone = await addUser(db, `gone@${DOMAIN}`);
      await admin(gone.email);
      expect(await admitted()).toBe(true);
      await deactivate(db, gone.id);
      expect(await admitted()).toBe(false);
      await admin((await addUser(db, `unverified@${DOMAIN}`, false)).email);
      expect(await admitted()).toBe(false);
      await admin(`nobody-yet@${DOMAIN}`);
      expect(await admitted()).toBe(true);
    }));
});
