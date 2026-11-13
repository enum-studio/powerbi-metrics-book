import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockPowerBi,
  startMockPowerBi,
  type MockPowerBiHandle,
} from "./index.js";
import { buildMock } from "./server.js";
import {
  createTestTenant,
  TEST_REDIRECT_URI,
  TEST_TENANT_ID,
} from "./test-tenant.js";

const ADA = "cccccccc-0000-4000-8000-000000000001";
const GRACE = "cccccccc-0000-4000-8000-000000000002";
const CLIENT_ID = "66666666-0000-4000-8000-000000000001";
const SCANNER_ID = "77777777-0000-4000-8000-000000000001";
const SCOPES =
  "openid offline_access https://analysis.windows.net/powerbi/api/Dataset.Read.All https://graph.microsoft.com/User.Read";

type Tokens = { id_token: string };

const started: MockPowerBiHandle[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((mock) => mock.close()));
});

async function start(options: { origin?: string } = {}) {
  const mock = await startMockPowerBi({
    tenant: createTestTenant(),
    ...options,
  });
  started.push(mock);
  return mock;
}

function postForm(url: string, form: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

/** The sign-in round trip over HTTP: authorize with PKCE, then redeem the code. */
async function connect(mock: MockPowerBiHandle) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(
    `${mock.url}/${TEST_TENANT_ID}/oauth2/v2.0/authorize`,
  );
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const redirect = await fetch(authorize, { redirect: "manual" });
  const code =
    new URL(redirect.headers.get("location") ?? mock.url).searchParams.get(
      "code",
    ) ?? "";
  const response = await postForm(
    `${mock.url}/${TEST_TENANT_ID}/oauth2/v2.0/token`,
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "web-secret",
      redirect_uri: TEST_REDIRECT_URI,
      code,
      code_verifier: verifier,
    },
  );
  return (await response.json()) as Tokens;
}

describe("startMockPowerBi", () => {
  it("names the origin it was reached at in tokens, or the origin it was given", async () => {
    const reached = await start();
    reached.setActingUser(ADA);
    const given = await start({ origin: "https://login.example.test" });
    given.setActingUser(ADA);

    const fromReached = await connect(reached);
    const fromGiven = await connect(given);

    expect(decodeJwt(fromReached.id_token).iss).toBe(
      `${reached.url}/${TEST_TENANT_ID}/v2.0`,
    );
    expect(decodeJwt(fromGiven.id_token).iss).toBe(
      `https://login.example.test/${TEST_TENANT_ID}/v2.0`,
    );
  });

  it("refuses an acting person the tenant does not have", async () => {
    const mock = await start();

    expect(() => {
      mock.setActingUser("nobody");
    }).toThrow(/No person nobody/);
  });

  it("makes the next request under a prefix fail once, with Retry-After when given", async () => {
    const mock = await start();
    mock.failNext("/graph", 429, 7);

    const other = await fetch(`${mock.url}/health`);
    const failed = await fetch(`${mock.url}/graph/v1.0/me/transitiveMemberOf`);
    const after = await fetch(`${mock.url}/graph/v1.0/me/transitiveMemberOf`);

    expect(other.status).toBe(200);
    expect(failed.status).toBe(429);
    expect(failed.headers.get("retry-after")).toBe("7");
    expect(after.status).toBe(401);
  });

  it("listens on a free loopback port and stops listening when closed", async () => {
    const mock = await startMockPowerBi({ tenant: createTestTenant() });
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${mock.url}/health`)).status).toBe(200);

    await mock.close();

    await expect(fetch(`${mock.url}/health`)).rejects.toThrow();
  });
});

describe("createMockPowerBi", () => {
  const request = (
    app: ReturnType<typeof createMockPowerBi>,
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    app.request(`http://mock.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("serves every route family of the core under its own prefix", async () => {
    const app = createMockPowerBi({ tenant: createTestTenant() });

    expect(
      (await request(app, `/${TEST_TENANT_ID}/discovery/v2.0/keys`)).status,
    ).toBe(200);
    expect((await request(app, "/oidc/jwks")).status).toBe(200);
    expect(
      (await request(app, "/graph/v1.0/me/transitiveMemberOf")).status,
    ).toBe(401);
    expect(
      (
        await request(app, "/openai/v1/embeddings", "POST", {
          model: "m",
          input: "x",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          app,
          "/gemini/v1beta/models/m:batchEmbedContents",
          "POST",
          {},
        )
      ).status,
    ).toBe(401);
    const health = await request(app, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  describe("the control route", () => {
    it("is absent unless the options ask for it", async () => {
      const app = createMockPowerBi({ tenant: createTestTenant() });

      expect((await request(app, "/_mock/reset", "POST")).status).toBe(404);
      expect(
        (await request(app, "/_mock/acting-user", "POST", { object_id: ADA }))
          .status,
      ).toBe(404);
    });

    it("sets the acting person, refusing one the tenant lacks", async () => {
      const { app, state } = buildMock({
        tenant: createTestTenant(),
        control: true,
      });

      const ok = await request(app, "/_mock/acting-user", "POST", {
        object_id: GRACE,
      });
      const unknown = await request(app, "/_mock/acting-user", "POST", {
        object_id: "nobody",
      });
      const missing = await request(app, "/_mock/acting-user", "POST", {});

      expect(ok.status).toBe(204);
      expect(state.acting_user).toBe(GRACE);
      expect(unknown.status).toBe(404);
      expect(missing.status).toBe(400);
    });

    it("patches the tenant settings and a service principal's right to call admin APIs", async () => {
      const { app, state } = buildMock({
        tenant: createTestTenant(),
        control: true,
      });

      const response = await request(app, "/_mock/settings", "PATCH", {
        dax_expressions: false,
        service_principal: { app_id: SCANNER_ID, may_call_admin_apis: false },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        settings: {
          detailed_metadata: true,
          dax_expressions: false,
          execute_queries: true,
          service_principals_admin_apis: true,
        },
        service_principals: [
          { app_id: SCANNER_ID, may_call_admin_apis: false },
        ],
      });
      expect(state.tenant.settings.dax_expressions).toBe(false);
      expect(state.tenant.service_principals[0]?.may_call_admin_apis).toBe(
        false,
      );
    });

    it("applies none of a settings patch that has a bad part", async () => {
      const { app, state } = buildMock({
        tenant: createTestTenant(),
        control: true,
      });

      const notASetting = await request(app, "/_mock/settings", "PATCH", {
        dax_expressions: false,
        nonsense: true,
      });
      const notABoolean = await request(app, "/_mock/settings", "PATCH", {
        execute_queries: "no",
      });
      const unknownPrincipal = await request(app, "/_mock/settings", "PATCH", {
        dax_expressions: false,
        service_principal: { app_id: "nobody", may_call_admin_apis: true },
      });

      expect([
        notASetting.status,
        notABoolean.status,
        unknownPrincipal.status,
      ]).toEqual([400, 400, 404]);
      expect(state.tenant.settings).toEqual(createTestTenant().settings);
    });

    it("queues a failure for the next request under a prefix", async () => {
      const app = createMockPowerBi({
        tenant: createTestTenant(),
        control: true,
      });

      const queued = await request(app, "/_mock/fail-next", "POST", {
        route_prefix: "/graph",
        status: 503,
        retry_after_seconds: 2,
      });
      const failed = await request(app, "/graph/v1.0/me/transitiveMemberOf");
      const after = await request(app, "/graph/v1.0/me/transitiveMemberOf");

      expect(queued.status).toBe(204);
      expect(failed.status).toBe(503);
      expect(failed.headers.get("retry-after")).toBe("2");
      expect(after.status).toBe(401);
    });

    it("refuses a failure that is not an error status", async () => {
      const app = createMockPowerBi({
        tenant: createTestTenant(),
        control: true,
      });

      const response = await request(app, "/_mock/fail-next", "POST", {
        route_prefix: "/graph",
        status: 200,
      });

      expect(response.status).toBe(400);
    });

    it("keeps answering itself while every other route is set to fail", async () => {
      const app = createMockPowerBi({
        tenant: createTestTenant(),
        control: true,
      });
      await request(app, "/_mock/fail-next", "POST", {
        route_prefix: "/",
        status: 500,
      });

      expect((await request(app, "/_mock/reset", "POST")).status).toBe(204);
    });

    it("resets the tenant to how it started, and forgets the acting person, grants and queued failures", async () => {
      const { app, state } = buildMock({
        tenant: createTestTenant(),
        control: true,
      });
      await request(app, "/_mock/acting-user", "POST", { object_id: ADA });
      await request(app, "/_mock/settings", "PATCH", {
        detailed_metadata: false,
      });
      await request(app, "/_mock/fail-next", "POST", {
        route_prefix: "/graph",
        status: 500,
      });
      state.tenant.people.length = 0;
      state.codes.set("c", {
        provider: "microsoft",
        client_id: CLIENT_ID,
        redirect_uri: "",
        scope: "",
        person_oid: ADA,
        code_challenge: "challenge",
        nonce: null,
        spent: false,
      });

      const response = await request(app, "/_mock/reset", "POST");

      expect(response.status).toBe(204);
      expect(state.tenant).toEqual(createTestTenant());
      expect(state.acting_user).toBeNull();
      expect(state.failures).toEqual([]);
      expect(state.codes.size).toBe(0);
    });
  });
});
