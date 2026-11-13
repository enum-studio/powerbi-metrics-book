import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  describesNothing,
  TEST_PUBLIC_BASE_URL,
  testPool,
} from "../../../test/deps.js";
import {
  fromSpa,
  pkce,
  startOAuth,
  toolAnswer,
} from "../../../test/sign-in-support.js";
import { createDb } from "../../db/client.js";
import { oauthClient, oauthRefreshToken } from "../../db/schema/auth.js";
import { digestToken } from "./oauth.js";

afterAll(closeTestPools);

const f = startOAuth();
const MCP = `${TEST_PUBLIC_BASE_URL}/api/mcp`;
const V1 = `${TEST_PUBLIC_BASE_URL}/api/v1`;

const refresh = (client_id: string, refresh_token: string) =>
  f.token({ grant_type: "refresh_token", refresh_token, client_id });
/** A token request with this exact form-encoded body, repeats and all. */
const raw = (body: string) =>
  f.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
const enc = encodeURIComponent;

describe("refresh tokens", () => {
  it("refuses a refresh token used twice, and the grant's access token stops working", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const first = await f.connect(cookie, client);
    const rotated = await refresh(client.client_id, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as { access_token: string };
    expect((await f.whoami(second.access_token)).status).toBe(200);

    const reused = await refresh(client.client_id, first.refresh_token);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
    expect((await f.whoami(second.access_token)).status).toBe(401);
  });

  /** A grant whose refresh token was reused, and the successor a rotation racing the reuse inserted after it (Better Auth #11317). */
  async function orphaned() {
    const { id, cookie } = await f.person();
    const client = f.client();
    const { refresh_token } = await f.connect(cookie, client);
    expect((await refresh(client.client_id, refresh_token)).status).toBe(200);
    expect((await refresh(client.client_id, refresh_token)).status).toBe(400);
    const successor = randomUUID();
    await f.deps.db.insert(oauthRefreshToken).values({
      id: randomUUID(),
      token: digestToken(successor),
      clientId: client.client_id,
      userId: id,
      scopes: ["mcp", "offline_access"],
      resources: [MCP],
      createdAt: new Date(Date.now() - 5000),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { cookie, client, successor };
  }

  it("refuses the successor a rotation racing the reuse left behind", async () => {
    const { client, successor } = await orphaned();
    expect((await refresh(client.client_id, successor)).status).toBe(400);
  });

  it("refuses that successor behind a decoy, even after the person connects the client again", async () => {
    const { cookie, client, successor } = await orphaned();
    const again = await f.connect(cookie, client);
    const answer = await raw(
      `grant_type=refresh_token&client_id=${enc(client.client_id)}&refresh_token=decoy&refresh_token=${enc(successor)}`,
    );
    expect(answer.status).toBe(400);
    expect(await answer.text()).not.toContain("access_token");
    expect((await f.whoami(again.access_token)).status).toBe(401);
  });

  it.each([
    ["behind a decoy", "refresh_token=decoy&refresh_token="],
    [
      "under a grant_type with a trailing space",
      "grant_type=refresh_token%20&refresh_token=",
    ],
  ])(
    "revokes the grant when a used refresh token comes %s",
    async (_, form) => {
      const { cookie } = await f.person();
      const client = f.client();
      const first = await f.connect(cookie, client);
      const rotated = await refresh(client.client_id, first.refresh_token);
      const { access_token } = (await rotated.json()) as {
        access_token: string;
      };
      const prefix = form.startsWith("grant_type")
        ? ""
        : "grant_type=refresh_token&";
      const reused = await raw(
        `${prefix}client_id=${enc(client.client_id)}&${form}${enc(first.refresh_token)}`,
      );
      expect(reused.status).toBe(400);
      expect((await f.whoami(access_token)).status).toBe(401);
    },
  );

  it("refuses a form bigger than a token request before asking the database anything", async () => {
    let queries = 0;
    const counted = new Proxy(testPool("api_rw"), {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (key !== "query" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          queries += 1;
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
    const counting = startOAuth({ pool: counted, db: createDb(counted) });
    const thousand = Array.from(
      { length: 1000 },
      (_, n) => `refresh_token=${String(n)}`,
    );
    for (const body of [thousand.join("&"), thousand.slice(0, 3).join("&")]) {
      queries = 0;
      const answer = await counting.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(await answer.json()).toMatchObject({ error: "invalid_request" });
      expect(queries).toBe(0);
    }
  });

  it("refuses a token request that is not form-encoded, or repeats a field", async () => {
    const json = await f.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "x" }),
    });
    const repeated = await raw(
      "grant_type=refresh_token&grant_type=authorization_code",
    );
    for (const answer of [json, repeated])
      expect(await answer.json()).toMatchObject({ error: "invalid_request" });
  });

  it("revokes the grant when one refresh token is used three times at once", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const first = await f.connect(cookie, client);
    const answers = await Promise.all(
      [1, 2, 3].map(() => refresh(client.client_id, first.refresh_token)),
    );
    const issued = await Promise.all(
      answers.map(
        async (answer) => (await answer.json()) as { access_token?: string },
      ),
    );
    expect(
      answers.filter((answer) => answer.status === 400).length,
    ).toBeGreaterThanOrEqual(2);
    for (const { access_token } of [first, ...issued])
      if (access_token !== undefined)
        expect((await f.whoami(access_token)).status).toBe(401);
  });
});

describe("access tokens", () => {
  it("are taken only at the resource in their audience, naming the person, the channel and the client", async () => {
    const g = startOAuth({ access: describesNothing() });
    const { id, cookie } = await g.person();
    const client = g.client();
    const mcp = await g.connect(cookie, client);
    const cli = await g.login(cookie);
    const asMcp = await g.whoami(mcp.access_token);
    expect(await toolAnswer(asMcp)).toMatchObject({
      kind: "person",
      id,
      via: "mcp",
      client_id: client.client_id,
      roles: ["viewer"],
    });
    const asCli = await g.bearer("/api/v1/test/principal", cli.access_token);
    expect(await asCli.json()).toMatchObject({
      id,
      via: "cli",
      client_id: "pbmb-cli",
    });
    for (const [path, refused] of [
      ["/api/v1/me", await g.bearer("/api/v1/me", mcp.access_token)],
      ["/api/mcp", await g.whoami(cli.access_token)],
    ] as const) {
      expect(refused.status, path).toBe(401);
      expect(refused.headers.get("www-authenticate"), path).toContain(
        'error="invalid_token"',
      );
    }
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client());
    const [head = "", body = "", signature = ""] = access_token.split(".");
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as object;
    const forged = Buffer.from(JSON.stringify({ ...claims, aud: V1 }));
    const token = `${head}.${forged.toString("base64url")}.${signature}`;
    expect((await f.bearer("/api/v1/me", token)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { cookie } = await f.person();
    const { access_token, expires_in } = await f.connect(cookie, f.client());
    expect(expires_in).toBe(3600);
    const later = startOAuth({
      clock: () => new Date(Date.now() + (expires_in + 1) * 1000),
    });
    expect((await later.whoami(access_token)).status).toBe(401);
  });

  it("answers 403 insufficient_scope to a token without the resource's scope", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client(), {
      scope: "offline_access",
    });
    const refused = await f.whoami(access_token);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope", scope="mcp"',
    );
  });

  it("answers 401 with resource_metadata when no credential is sent", async () => {
    for (const [path, resource] of [
      ["/api/mcp", "api/mcp"],
      ["/api/v1/me", "api/v1"],
    ]) {
      const refused = await f.request(path ?? "");
      expect(refused.status, path).toBe(401);
      expect(refused.headers.get("www-authenticate"), path).toBe(
        `Bearer resource_metadata="${TEST_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/${resource ?? ""}"`,
      );
    }
  });

  it("stop at once when the person revokes the grant, which no one else can", async () => {
    const { cookie } = await f.person();
    const { access_token } = await f.connect(cookie, f.client());
    const listed = await f.request("/api/v1/me/grants", {
      headers: { cookie },
    });
    const { grants } = (await listed.json()) as { grants: { id: string }[] };
    const revoke = (as: string) =>
      f.request(`/api/v1/me/grants/${grants[0]?.id ?? ""}`, {
        method: "DELETE",
        headers: { cookie: as, origin: TEST_PUBLIC_BASE_URL },
      });
    expect((await revoke((await f.person()).cookie)).status).toBe(404);
    expect((await f.whoami(access_token)).status).toBe(200);
    expect((await revoke(cookie)).status).toBe(204);
    expect((await f.whoami(access_token)).status).toBe(401);
  });
});

describe("authorization", () => {
  it("refuses PKCE plain, and an authorization without PKCE", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const challenges: Record<string, string>[] = [
      { code_challenge: pkce().verifier, code_challenge_method: "plain" },
      {},
    ];
    for (const challenge of challenges) {
      const answer = await f.authorize(cookie, {
        response_type: "code",
        ...client,
        resource: MCP,
        ...challenge,
      });
      const back = new URL(answer.headers.get("location") ?? "");
      expect(`${back.origin}${back.pathname}`).toBe(client.redirect_uri);
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.has("code")).toBe(false);
    }
  });

  it("refuses an authorization that names no resource, or an empty one", async () => {
    const { cookie } = await f.person();
    const resources: Record<string, string>[] = [{}, { resource: "" }];
    for (const resource of resources) {
      const answer = await f.authorize(cookie, {
        response_type: "code",
        ...f.client(),
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        ...resource,
      });
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ error: "invalid_target" });
    }
  });

  it.each([
    ["backchannel_logout_uri", "https://internal.example.org/logout"],
    ["backchannel_logout_session_required", true],
    ["jwks_uri", "https://internal.example.org/jwks"],
    ["post_logout_redirect_uris", ["https://internal.example.org/out"]],
  ])(
    "refuses a registration that carries %s, which would make the api fetch",
    async (field, value) => {
      const answer = await f.request("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "fetching client",
          redirect_uris: ["https://fetching.example.org/callback"],
          [field]: value,
        }),
      });
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({
        error: "invalid_client_metadata",
      });
    },
  );

  it("grants a dynamically registered client nothing until the person presses Allow", async () => {
    const { cookie } = await f.person();
    const redirect_uri = "https://registered.example.org/callback";
    // A native client registers with no Origin, as Cursor and Codex do.
    const registered = await f.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "registered client",
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const { challenge, verifier } = pkce();
    const authorized = await f.authorize(cookie, {
      response_type: "code",
      client_id,
      redirect_uri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP,
    });
    expect(authorized.headers.get("location")).toMatch(
      new RegExp(`^${TEST_PUBLIC_BASE_URL}/oauth/consent\\?`),
    );
    const guessed = await f.token({
      grant_type: "authorization_code",
      code: randomUUID(),
      redirect_uri,
      client_id,
      code_verifier: verifier,
    });
    expect(guessed.status).toBe(400);
    const listed = await f.request("/api/v1/me/grants", {
      headers: { cookie },
    });
    expect(await listed.json()).toEqual({ grants: [] });
    const denied = await f.consent(cookie, authorized, false);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.has("code")).toBe(false);
    const { access_token } = await f.connect(cookie, {
      client_id,
      redirect_uri,
    });
    expect((await f.whoami(access_token)).status).toBe(200);
  });

  it.each([
    ["resources", { resources: [V1] }],
    ["resources beside the MCP's", { resources: [MCP, V1] }],
    ["scope", { scope: "v1 mcp offline_access" }],
  ])(
    "refuses a registration that asks for the v1 resource in %s",
    async (_field, asked) => {
      const answer = await f.request("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "greedy client",
          redirect_uris: ["https://greedy.example.org/callback"],
          token_endpoint_auth_method: "none",
          ...asked,
        }),
      });
      expect(answer.status).toBe(400);
    },
  );

  it.each([
    ["resource", { resource: V1 }],
    ["audience", { audience: V1 }],
  ])(
    "gives a client whose registration names the v1 resource in %s, which registration ignores, a token /api/v1 refuses",
    async (_field, asked) => {
      const { cookie } = await f.person();
      const redirect_uri = "https://greedy.example.org/callback";
      const registered = await f.request("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "greedy client",
          redirect_uris: [redirect_uri],
          token_endpoint_auth_method: "none",
          ...asked,
        }),
      });
      expect(registered.status).toBe(201);
      const client = (await registered.json()) as {
        client_id: string;
        resources: string[];
      };
      expect(client.resources).toEqual([MCP]);
      const { access_token } = await f.connect(cookie, {
        client_id: client.client_id,
        redirect_uri,
      });
      const refused = await f.bearer("/api/v1/me", access_token);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
      expect((await f.whoami(access_token)).status).toBe(200);
      const askedV1 = await f.authorize(cookie, {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        scope: "mcp offline_access",
        resource: V1,
      });
      expect(
        new URL(askedV1.headers.get("location") ?? "").searchParams.get(
          "error",
        ),
      ).toBe("invalid_target");
    },
  );

  it("refuses a client metadata document whose URL resolves to a private address", async () => {
    const { cookie } = await f.person();
    const client_id = `https://client.example.org/${randomUUID()}/client.json`;
    const answer = await f.authorize(cookie, {
      response_type: "code",
      client_id,
      redirect_uri: "https://client.example.org/callback",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: MCP,
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({
      error: "invalid_client",
      // The same sentence whatever failed: no address, no reason.
      error_description: "The client's metadata document could not be read.",
    });
    const stored = await f.deps.db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, client_id));
    expect(stored).toEqual([]);
  });

  it("takes a device code for the CLI only, and an answer only from a browser", async () => {
    const started = await f.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: f.client().client_id,
        scope: "api offline_access",
        resource: V1,
      }).toString(),
    });
    expect(await started.json()).toMatchObject({ error: "invalid_client" });
    const { access_token } = await f.login((await f.person()).cookie);
    const answered = await f.request("/api/v1/oauth/device", {
      ...fromSpa("", { user_code: "ABCDEFGH", allow: true }),
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      },
    });
    expect(answered.status).toBe(403);
  });
});
