import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import {
  OIDC,
  followConnect,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { personIdentity, powerbiAccess } from "../../db/schema/mirror.js";
import { personPrincipal } from "../auth/principal.js";
import { assignRole, MICROSOFT, readIdentity } from "../auth/roles.js";

/*
 * Connecting, end to end through the api's routes and the mock: Microsoft's
 * sign-in chaining into the connection, the groups read through Graph,
 * /api/v1/me, and disconnecting.
 */

let f: SignInFixture;

beforeAll(async () => {
  f = await startSignIn();
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

async function me(cookie: string): Promise<Record<string, unknown>> {
  const answer = await f.request("/api/v1/me", { headers: { cookie } });
  expect(answer.status).toBe(200);
  return (await answer.json()) as Record<string, unknown>;
}

describe("connecting Power BI", () => {
  it.each([false, true])(
    "names the connections page for an incomplete callback (state: %s)",
    async (validState) => {
      const { cookie } = await f.signIn(f.person("viewer"), MICROSOFT);
      const started = await f.request("/api/v1/powerbi/connect", {
        headers: { cookie },
      });
      const state = new URL(
        String(started.headers.get("location")),
      ).searchParams.get("state");
      if (state === null) throw new Error("Connect returned no state");
      const answer = await f.request(
        `/api/v1/powerbi/callback?state=${validState ? state : "missing"}`,
        { headers: { cookie } },
      );
      expect(answer.status).toBe(403);
      const message: unknown = expect.stringContaining(
        `Connect Power BI again at ${TEST_PUBLIC_BASE_URL}/settings/connections, then run this again.`,
      );
      expect(await answer.json()).toMatchObject({ message });
    },
  );

  it("refuses a matching directory email with a different UPN under strict rules", async () => {
    const member = {
      ...f.person("outsider"),
      object_id: crypto.randomUUID(),
      email: "strict@sample.example",
      user_principal_name: "different@sample.example",
    };
    f.tenant.people.push(member);
    await assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: member.email },
      principals.admin,
    );
    const { cookie } = await f.signIn(member, OIDC);
    await f.settings.set("powerbi.connection_requires_matching_email", true);
    try {
      const { answer } = await followConnect(f.app, cookie);
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as { message: string }).message).toMatch(
        /whose email address is yours/,
      );
      expect(
        await readIdentity(f.deps.db, await f.userId(member.email)),
      ).toBeNull();
    } finally {
      await f.settings.set("powerbi.connection_requires_matching_email", false);
    }
  });

  it("stores the person's object id and principal name after connecting through Microsoft", async () => {
    const person = f.person("admin");
    const { cookie } = await f.signIn(person, MICROSOFT);
    const { answer } = await followConnect(f.app, cookie);
    expect(answer.status).toBe(302);
    const [row] = await f.deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, await f.userId(person.email)));
    expect(row).toMatchObject({
      status: "connected",
      microsoft_object_id: person.object_id,
      user_principal_name: person.user_principal_name,
    });
  });

  it("chains Microsoft's sign-in into the connection, reads the groups through Graph and goes where the person was going", async () => {
    const leader = f.person("leader");
    const { callback, cookie } = await f.signIn(
      leader,
      MICROSOFT,
      `/api/v1/powerbi/connect?next=${encodeURIComponent("/review/metrics/revenue")}`,
    );
    const chained = new URL(
      String(callback.headers.get("location")),
      TEST_PUBLIC_BASE_URL,
    );
    expect(chained.pathname).toBe("/api/v1/powerbi/connect");
    // A third group since sign-in: Graph answers it on a second page of two.
    leader.group_ids.push(f.group("Analysts"));

    const { answer } = await followConnect(
      f.app,
      cookie,
      `${chained.pathname}${chained.search}`,
    );
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("/review/metrics/revenue");

    const id = await f.userId(leader.email);
    const [row] = await f.deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, id));
    expect(row).toMatchObject({
      status: "connected",
      microsoft_object_id: leader.object_id,
      user_principal_name: leader.user_principal_name,
      last_error: null,
    });
    expect(row?.scopes.join(" ")).toMatch(/Dataset\.Read\.All/);
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.group_object_ids.toSorted()).toEqual(
      leader.group_ids.toSorted(),
    );
    expect(leader.group_ids).toHaveLength(3);
    expect(await me(cookie)).toMatchObject({
      powerbi_connection: "connected",
      powerbi_connect_url: `${TEST_PUBLIC_BASE_URL}/settings/connections`,
    });
  });

  it("disconnects by deleting both tokens, from this app's own pages only, and audits both", async () => {
    const analyst = f.person("analyst");
    const { cookie } = await f.signIn(analyst, MICROSOFT);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    const id = await f.userId(analyst.email);
    const disconnect = (headers: Record<string, string>) =>
      f.request("/api/v1/powerbi/connection", {
        method: "DELETE",
        headers: { cookie, ...headers },
      });

    expect((await disconnect({})).status).toBe(403);
    expect(await me(cookie)).toMatchObject({ powerbi_connection: "connected" });
    expect((await disconnect({ origin: TEST_PUBLIC_BASE_URL })).status).toBe(
      204,
    );
    const [row] = await f.deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, id));
    expect(row).toMatchObject({
      status: "disconnected",
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      recipient: null,
    });
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.groups_read_at).toBeNull();
    expect(await me(cookie)).toMatchObject({
      powerbi_connection: "disconnected",
    });
    const audited = await createDb(testPool("migrator"))
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.principal_id, id))
      .orderBy(auditEvent.id);
    expect(audited.map((event) => [event.action, event.decision])).toEqual([
      ["powerbi.connect", "allow"],
      ["powerbi.disconnect", "allow"],
    ]);
  });

  it("keeps the account when Graph fails after it, and says what happened", async () => {
    const viewer = f.person("viewer");
    const { cookie } = await f.signIn(viewer, MICROSOFT);
    f.failNext("/graph", 503);
    const { answer } = await followConnect(f.app, cookie);
    expect(answer.status).toBe(502);
    expect(((await answer.json()) as { message: string }).message).toMatch(
      /^Power BI is connected, but your groups were not read yet/,
    );
    const id = await f.userId(viewer.email);
    const [row] = await f.deps.db
      .select()
      .from(powerbiConnection)
      .where(eq(powerbiConnection.user_id, id));
    expect(row?.status).toBe("connected");
    const [identity] = await f.deps.db
      .select()
      .from(personIdentity)
      .where(eq(personIdentity.user_id, id));
    expect(identity?.microsoft_object_id).toBe(viewer.object_id);
  });

  it("keeps what the person reaches through their account and groups while a reconnect waits for Graph", async () => {
    const { person, reach, own, grouped } = await reachingPerson("reconnect");
    const { cookie } = await f.signIn(person, MICROSOFT);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(302);
    expect(await reach()).toEqual([own, grouped].sort());

    // Every Microsoft sign-in connects again. Graph failing holds the
    // reconnect where it stands between storing the account and reading
    // its groups, which the person's other requests must not notice.
    const again = await f.signIn(person, MICROSOFT);
    f.failNext("/graph", 503);
    expect((await followConnect(f.app, again.cookie)).answer.status).toBe(502);
    expect(await reach()).toEqual([own, grouped].sort());
  });

  it("lets a first connection reach through its own account before Graph reads its groups", async () => {
    const { person, reach, own } = await reachingPerson("first");
    const { cookie } = await f.signIn(person, MICROSOFT);
    f.failNext("/graph", 503);
    expect((await followConnect(f.app, cookie)).answer.status).toBe(502);
    // Microsoft proved the account a moment ago; its groups are not read yet.
    expect(await reach()).toEqual([own]);
  });
});

/**
 * A new person in one group, with a workspace their account is on and one
 * their group is on, and the workspaces their principal reaches now.
 */
async function reachingPerson(name: string) {
  const person = {
    ...f.person("outsider"),
    object_id: crypto.randomUUID(),
    email: `${name}-${crypto.randomUUID()}@sample.example`,
    user_principal_name: `${name}@sample.example`,
    group_ids: [f.group("Analysts")],
  };
  f.tenant.people.push(person);
  const [own, grouped] = [crypto.randomUUID(), crypto.randomUUID()];
  const [group] = person.group_ids;
  if (group === undefined) throw new Error("the person has no group");
  await createDb(testPool("migrator"))
    .insert(powerbiAccess)
    .values([
      {
        object_kind: "workspace",
        object_id: own,
        principal_type: "user",
        principal_object_id: person.object_id,
        access_right: "Member",
      },
      {
        object_kind: "workspace",
        object_id: grouped,
        principal_type: "group",
        principal_object_id: group,
        access_right: "Member",
      },
    ]);
  const reach = async () =>
    (
      await personPrincipal(
        f.deps,
        {
          id: await f.userId(person.email),
          email: person.email,
          email_verified: true,
        },
        { via: "browser", client_id: null },
      )
    ).attributes.powerbi_workspace_ids;
  return { person, reach, own, grouped };
}

describe("who may connect", () => {
  it("answers 401 to each route without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/powerbi/connect"],
      ["GET", "/api/v1/powerbi/callback?state=x&code=y"],
      ["DELETE", "/api/v1/powerbi/connection"],
    ] as const) {
      const answer = await f.request(path, {
        method,
        headers: { origin: TEST_PUBLIC_BASE_URL },
      });
      expect(answer.status, `${method} ${path}`).toBe(401);
    }
  });

  it("refuses a person no role reaches, on connect and on the callback", async () => {
    const { cookie } = await f.signIn(f.person("admin"), MICROSOFT);
    await f.settings.set("access.default_role", "none");
    try {
      for (const path of [
        "/api/v1/powerbi/connect",
        "/api/v1/powerbi/callback?state=x&code=y",
      ])
        expect((await f.request(path, { headers: { cookie } })).status).toBe(
          403,
        );
    } finally {
      await f.settings.set("access.default_role", "viewer");
    }
  });

  it.each([
    ["viewer", "app-reader"],
    ["curator", "sales-viewer"],
    ["admin", "outsider"],
  ])(
    "sends a person holding %s to Microsoft with PKCE and their address",
    async (role, mailbox) => {
      const who = f.person(mailbox);
      await assignRole(
        f.deps.db,
        { role, subject_kind: "person", subject: who.email },
        principals.admin,
      );
      const { cookie } = await f.signIn(who, MICROSOFT);
      const answer = await f.request("/api/v1/powerbi/connect", {
        headers: { cookie },
      });
      expect(answer.status).toBe(302);
      const authorize = new URL(String(answer.headers.get("location")));
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        code_challenge_method: "S256",
        login_hint: who.email,
      });
    },
  );
});
