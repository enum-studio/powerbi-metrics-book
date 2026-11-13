import { eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import { waitingOn } from "../../../test/locks.js";
import { MemorySettings } from "../../../test/doubles.js";
import { fromSpa, pkce, startOAuth } from "../../../test/sign-in-support.js";
import {
  oauthClient,
  oauthClientActivity,
  oauthConsentUse,
  verification,
} from "../../db/schema/auth.js";
import {
  listAllGrants,
  noteGrantUse,
  pruneIdleClients,
  revokeConnection,
  signOutEverywhere,
} from "./grants.js";

afterAll(closeTestPools);

const f = startOAuth();

type Listed = {
  grants: {
    id: string;
    client_id: string;
    via: string;
    last_used_at: string | null;
  }[];
};

async function grantsOf(cookie: string): Promise<Listed["grants"]> {
  const answer = await f.request("/api/v1/me/grants", { headers: { cookie } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as Listed).grants;
}

const revoke = (cookie: string, id: string) =>
  f.request(`/api/v1/me/grants/${id}`, {
    method: "DELETE",
    headers: { cookie, origin: TEST_PUBLIC_BASE_URL },
  });

describe("/api/v1/me/grants", () => {
  it("shows a person their own MCP and CLI grants and no one else's", async () => {
    const mine = await f.person();
    const theirs = await f.person();
    const client = f.client();
    await f.connect(mine.cookie, client);
    await f.login(mine.cookie);
    await f.connect(theirs.cookie, f.client());
    const listed = await grantsOf(mine.cookie);
    // Both were granted within one second, so either may come first.
    expect(listed.map(({ client_id, via }) => [client_id, via]).sort()).toEqual(
      [
        [client.client_id, "mcp"],
        ["pbmb-cli", "cli"],
      ].sort(),
    );
    expect(await grantsOf(theirs.cookie)).toHaveLength(1);
  });

  it("revokes only the person's own grant", async () => {
    const mine = await f.person();
    const theirs = await f.person();
    const { access_token } = await f.login(mine.cookie);
    const [grant] = await grantsOf(mine.cookie);
    expect((await revoke(theirs.cookie, grant?.id ?? "")).status).toBe(404);
    expect(await grantsOf(mine.cookie)).toHaveLength(1);
    expect((await revoke(mine.cookie, grant?.id ?? "")).status).toBe(204);
    expect(await grantsOf(mine.cookie)).toEqual([]);
    expect((await f.bearer("/api/v1/me", access_token)).status).toBe(401);
  });

  it("answers 401 without a credential", async () => {
    expect((await f.request("/api/v1/me/grants")).status).toBe(401);
    expect((await revoke("", "any")).status).toBe(401);
  });
});

describe("revokeConnection", () => {
  const deps = { ...f.deps, access: cerbosAccess(new MemorySettings()) };

  it("lets an admin end anyone's grant at once", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client());
    const [grant] = await grantsOf(cookie);
    await revokeConnection(deps, principals.admin, grant?.id ?? "");
    expect(await grantsOf(cookie)).toEqual([]);
    expect((await f.whoami(access_token)).status).toBe(401);
  });

  it.each(["viewer", "curator"] as const)(
    "refuses a %s, and the grant stands",
    async (role) => {
      const { cookie } = await f.person();
      const { access_token } = await f.connect(cookie, f.client());
      const [grant] = await grantsOf(cookie);
      await expect(
        revokeConnection(deps, principals[role], grant?.id ?? ""),
      ).rejects.toMatchObject({ kind: "refused" });
      expect((await f.whoami(access_token)).status).toBe(200);
    },
  );
});

describe("a grant's last use", () => {
  const usesOf = (id: string) =>
    f.deps.db
      .select()
      .from(oauthConsentUse)
      .where(eq(oauthConsentUse.consent_id, id));

  it("is noted when the connector or the API accepts its token, and shown to the person and the admin", async () => {
    const person = await f.person();
    const { access_token: mcp } = await f.connect(person.cookie, f.client());
    const { access_token: cli } = await f.login(person.cookie);
    expect((await grantsOf(person.cookie)).map((g) => g.last_used_at)).toEqual([
      null,
      null,
    ]);
    expect((await f.whoami(mcp)).status).toBe(200);
    expect((await f.bearer("/api/v1/me", cli)).status).toBe(200);
    const listed = await grantsOf(person.cookie);
    expect(listed.every((g) => g.last_used_at !== null)).toBe(true);
    const byPerson = await listAllGrants(f.deps.db);
    expect(
      byPerson
        .get(person.id)
        ?.map((g) => [g.id, g.last_used_at])
        .sort(),
    ).toEqual(listed.map((g) => [g.id, g.last_used_at]).sort());
  });

  it("is not noted for a token refused for its scope", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client(), {
      scope: "offline_access",
    });
    expect((await f.whoami(access_token)).status).toBe(403);
    expect((await grantsOf(cookie))[0]?.last_used_at).toBeNull();
  });

  it("is written at most once a minute", async () => {
    let now = new Date();
    const clocked = startOAuth({ clock: () => now });
    const { cookie } = await clocked.person();
    const { access_token } = await clocked.connect(cookie, clocked.client());
    const [grant] = await grantsOf(cookie);
    const id = grant?.id ?? "";
    const usedAt = async (at: Date) => {
      now = at;
      expect((await clocked.whoami(access_token)).status).toBe(200);
      return (await usesOf(id))[0]?.last_used_at;
    };
    const first = new Date();
    expect(await usedAt(first)).toEqual(first);
    expect(await usedAt(new Date(first.getTime() + 59_000))).toEqual(first);
    const later = new Date(first.getTime() + 60_001);
    expect(await usedAt(later)).toEqual(later);
  });

  it("is not noted for a revoked grant", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client());
    expect((await f.whoami(access_token)).status).toBe(200);
    const [grant] = await grantsOf(cookie);
    const id = grant?.id ?? "";
    expect(await usesOf(id)).toHaveLength(1);
    expect((await revoke(cookie, id)).status).toBe(204);
    expect((await f.whoami(access_token)).status).toBe(401);
    expect(await usesOf(id)).toEqual([]);
  });

  it("waits for a revoke that lands while a token is checked, then writes nothing and refuses it", async () => {
    const { cookie } = await f.person();
    await f.connect(cookie, f.client());
    const [grant] = await grantsOf(cookie);
    const id = grant?.id ?? "";
    const holder = await testPool("api_rw").connect();
    let committed = false;
    try {
      await holder.query("begin");
      const { rows } = await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      await holder.query("delete from oauth_consent where id = $1", [id]);
      const noting = noteGrantUse(
        f.deps.db,
        { id, last_used_at: null },
        new Date(),
      );
      await waitingOn(rows[0]?.pid ?? 0, 1);
      await holder.query("commit");
      committed = true;
      expect(await noting).toBe(false);
    } finally {
      // A connection left inside its transaction is closed, not pooled.
      holder.release(!committed);
    }
    expect(await usesOf(id)).toEqual([]);
  });
});

describe("clients nobody allowed", () => {
  it("are deleted after a day, when another client is created, and allowed ones stay", async () => {
    const { cookie } = await f.person();
    const allowed = f.client();
    await f.connect(cookie, allowed);
    const idle = f.client();
    // Naming a client at authorize stores it, before anyone allows it.
    await f.authorize(cookie, {
      response_type: "code",
      ...idle,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: `${TEST_PUBLIC_BASE_URL}/api/mcp`,
    });
    const ids = [allowed.client_id, idle.client_id];
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await f.deps.db
      .update(oauthClient)
      .set({ createdAt: old, updatedAt: old })
      .where(inArray(oauthClient.clientId, ids));
    await f.deps.db
      .update(oauthClientActivity)
      .set({ authorized_at: old })
      .where(inArray(oauthClientActivity.client_id, ids));
    const registered = await f.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "newer client",
        redirect_uris: ["https://newer.example.org/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const left = await f.deps.db
      .select({ id: oauthClient.clientId })
      .from(oauthClient)
      .where(inArray(oauthClient.clientId, ids));
    expect(left).toEqual([{ id: allowed.client_id }]);
  });
});

describe("clients being authorized", () => {
  it("survive pruning however old, so the person's Allow still lands", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const authorized = await f.authorize(cookie, {
      response_type: "code",
      ...client,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: `${TEST_PUBLIC_BASE_URL}/api/mcp`,
    });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await f.deps.db
      .update(oauthClient)
      .set({ createdAt: old, updatedAt: old })
      .where(eq(oauthClient.clientId, client.client_id));
    await pruneIdleClients(f.deps.db, new Date());
    const back = await f.consent(cookie, authorized, true);
    expect(back.searchParams.has("code")).toBe(true);
  });
});

describe("the consent and device routes", () => {
  const paths = ["/api/v1/oauth/consent", "/api/v1/oauth/device"];

  it("answer 401 without a credential", async () => {
    for (const path of paths) {
      expect((await f.request(path)).status, path).toBe(401);
      expect((await f.request(path, fromSpa("", { allow: true }))).status).toBe(
        401,
      );
    }
  });

  it("refuse a person answering with a token rather than in the browser", async () => {
    const { access_token } = await f.login((await f.person()).cookie);
    const authorization = `Bearer ${access_token}`;
    for (const path of paths) {
      const looked = await f.request(path, { headers: { authorization } });
      expect(looked.status, path).toBe(403);
      const answered = await f.request(path, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ request: "", user_code: "", allow: true }),
      });
      expect(answered.status, path).toBe(403);
    }
  });
});

describe("signing a person out everywhere", () => {
  /** The person back through the dev sign-in, as after any sign-out. */
  async function signInAgain(email: string): Promise<string> {
    const answer = await f.request(
      "/api/auth/dev/sign-in",
      fromSpa("", { email }),
    );
    expect(answer.status).toBe(200);
    return answer.headers.getSetCookie().join("; ");
  }
  /** The person's authorization codes not yet exchanged, as the OAuth provider stores them. */
  async function codesOf(user_id: string) {
    const rows = await f.deps.db
      .select({ value: verification.value })
      .from(verification)
      .where(like(verification.value, '{"type":"authorization_code",%'));
    return rows.filter(
      ({ value }) =>
        (JSON.parse(value) as { userId?: string }).userId === user_id,
    );
  }

  it("ends an authorization code not yet exchanged, though the person allows the client again", async () => {
    const person = await f.person();
    const client = f.client();
    const { verifier, challenge } = pkce();
    const authorized = await f.authorize(person.cookie, {
      response_type: "code",
      ...client,
      state: "sample-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${TEST_PUBLIC_BASE_URL}/api/mcp`,
    });
    const back = await f.consent(person.cookie, authorized, true);
    expect(await codesOf(person.id)).toHaveLength(1);
    await signOutEverywhere(f.deps.db, person.id);
    expect(await codesOf(person.id)).toEqual([]);
    await f.connect(await signInAgain(person.email), client);
    const answer = await f.token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: client.redirect_uri,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("ends a device code the person allowed and the CLI has not collected", async () => {
    const person = await f.person();
    const started = await f.startLogin();
    const { device_code, user_code } = (await started.json()) as {
      device_code: string;
      user_code: string;
    };
    expect((await f.answerCode(person.cookie, user_code, true)).status).toBe(
      204,
    );
    await signOutEverywhere(f.deps.db, person.id);
    await f.login(await signInAgain(person.email));
    const answer = await f.poll(device_code);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: "invalid_grant" });
  });
});
