import { createHash, randomBytes } from "node:crypto";
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { describe, expect, it } from "vitest";
import { buildMock } from "../server.js";
import {
  createTestTenant,
  TEST_REDIRECT_URI,
  TEST_TENANT_ID,
} from "../test-tenant.js";
import { setActingUser, type MockState } from "./context.js";
import { GRAPH_AUDIENCE, POWER_BI_AUDIENCE } from "./tokens.js";

const ADA = "cccccccc-0000-4000-8000-000000000001";
const GRACE = "cccccccc-0000-4000-8000-000000000002";
const CLIENT_ID = "66666666-0000-4000-8000-000000000001";
const OTHER_CLIENT_ID = "66666666-0000-4000-8000-000000000002";
const SCANNER_ID = "77777777-0000-4000-8000-000000000001";
const SCOPES =
  "openid profile offline_access https://analysis.windows.net/powerbi/api/Dataset.Read.All https://graph.microsoft.com/User.Read";
const GRAPH_ME = "https://graph.microsoft.com/User.Read";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token: string;
  scope: string;
  expires_in: number;
};

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function redirectParameters(response: Response): URLSearchParams {
  const location = response.headers.get("location");
  if (!location)
    throw new Error(`expected a redirect, got ${String(response.status)}`);
  return new URL(location).searchParams;
}

function codeOf(response: Response): string {
  return redirectParameters(response).get("code") ?? "";
}

/** A second registered app, so a test can present one app's grant from another. */
function addOtherClient(state: MockState) {
  state.tenant.apps_registrations.push({
    client_id: OTHER_CLIENT_ID,
    secret: "other-secret",
    redirect_uris: [TEST_REDIRECT_URI],
    kind: "confidential_web",
  });
}

function startMock(acting_user = ADA) {
  const { app, state } = buildMock({ tenant: createTestTenant() });
  setActingUser(state, acting_user);
  const pkce = pkcePair();

  /** PKCE on by default, as the mock insists; a key set to undefined leaves that parameter out. */
  const authorize = (query: Record<string, string | undefined> = {}) => {
    const url = new URL(
      `http://mock.test/${TEST_TENANT_ID}/oauth2/v2.0/authorize`,
    );
    const parameters: Record<string, string | undefined> = {
      client_id: CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      state: "s1",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      ...query,
    };
    url.search = new URLSearchParams(
      Object.entries(parameters).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ).toString();
    return app.request(url);
  };

  const token = (form: Record<string, string>, tenant = TEST_TENANT_ID) =>
    app.request(`http://mock.test/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });

  /** The verifier of the challenge `authorize` sends, unless another is given; null leaves it out. */
  const redeem = (code: string, code_verifier: string | null = pkce.verifier) =>
    token({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "web-secret",
      redirect_uri: TEST_REDIRECT_URI,
      code,
      ...(code_verifier === null ? {} : { code_verifier }),
    });

  const refresh = (
    refresh_token: string,
    scope?: string,
    credentials = { client_id: CLIENT_ID, client_secret: "web-secret" },
  ) =>
    token({
      grant_type: "refresh_token",
      ...credentials,
      refresh_token,
      ...(scope ? { scope } : {}),
    });

  /** Signs in with PKCE and answers what the token endpoint gave. */
  async function signIn(
    nonce?: string,
    scope = SCOPES,
  ): Promise<TokenResponse> {
    const response = await redeem(codeOf(await authorize({ nonce, scope })));
    expect(response.status).toBe(200);
    return (await response.json()) as TokenResponse;
  }

  return { app, state, pkce, authorize, token, redeem, refresh, signIn };
}

describe("OpenID configuration", () => {
  it.each([TEST_TENANT_ID, "example.test"])(
    "discovers the tenant by its ID or domain: %s",
    async (tenant) => {
      const { app } = startMock();
      const response = await app.request(
        `http://mock.test/${tenant}/v2.0/.well-known/openid-configuration`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        issuer: `http://mock.test/${TEST_TENANT_ID}/v2.0`,
        authorization_endpoint: `http://mock.test/${TEST_TENANT_ID}/oauth2/v2.0/authorize`,
        token_endpoint: `http://mock.test/${TEST_TENANT_ID}/oauth2/v2.0/token`,
        jwks_uri: `http://mock.test/${TEST_TENANT_ID}/discovery/v2.0/keys`,
      });
    },
  );
  it("refuses an unknown tenant", async () => {
    const response = await startMock().app.request(
      "http://mock.test/unknown.example/v2.0/.well-known/openid-configuration",
    );
    expect(response.status).toBe(400);
    const answer: unknown = await response.json();
    expect(answer).toMatchObject({ error: "invalid_tenant" });
    expect(answer).toHaveProperty(
      "error_description",
      expect.stringContaining(
        "AADSTS90002: Tenant 'unknown.example' not found.",
      ),
    );
  });
});

describe("authorization code flow", () => {
  it.each(["openid", "openid profile", "openid email", "openid profile email"])(
    "limits ID token claims to granted scopes: %s",
    async (scope) => {
      const claims = decodeJwt(
        (await startMock().signIn(undefined, scope)).id_token,
      );
      for (const key of ["oid", "name", "preferred_username"])
        expect(key in claims).toBe(scope.includes("profile"));
      expect("email" in claims).toBe(scope.includes("email"));
    },
  );

  it("issues verified and unverified email domains with a distinct UPN", async () => {
    const mock = startMock();
    expect(
      decodeJwt((await mock.signIn(undefined, "openid profile email")).id_token)
        .xms_edov,
    ).toBe(true);
    const person = mock.state.tenant.people[0];
    if (person === undefined) throw new Error("The mock needs its member");
    person.email = "invited@untrusted.example";
    expect(
      decodeJwt(
        (await mock.signIn(undefined, "openid profile email")).id_token,
      ),
    ).toMatchObject({
      email: person.email,
      preferred_username: person.user_principal_name,
      xms_edov: false,
    });
  });

  it("uses a guest's home address as preferred_username even without an email claim", async () => {
    const mock = startMock();
    const member = mock.state.tenant.people[0];
    if (member === undefined) throw new Error("The mock needs its member");
    Object.assign(member, {
      guest: true,
      home_address: "ada@partner.example",
      email: "",
    });
    const claims = decodeJwt((await mock.signIn()).id_token);
    expect(claims.preferred_username).toBe("ada@partner.example");
    expect(claims).not.toHaveProperty("email");
  });

  it("sends optional and guest email claims without the email scope", async () => {
    const mock = startMock();
    expect(
      decodeJwt((await mock.signIn(undefined, "openid profile")).id_token),
    ).not.toHaveProperty("email");
    const app = mock.state.tenant.apps_registrations[0];
    if (app === undefined) throw new Error("The mock needs its app");
    Object.assign(app, {
      email_optional_claim: true,
    });
    expect(decodeJwt((await mock.signIn()).id_token).email).toBe(
      "ada@example.test",
    );
    mock.state.reset();
    setActingUser(mock.state, ADA);
    expect(
      mock.state.tenant.apps_registrations[0]?.email_optional_claim,
    ).toBeUndefined();
    const member = mock.state.tenant.people[0];
    if (member === undefined) throw new Error("The mock needs its member");
    Object.assign(member, {
      guest: true,
      home_address: "ada@partner.example",
    });
    expect(decodeJwt((await mock.signIn()).id_token).email).toBe(
      "ada@example.test",
    );
  });

  it("refuses a token request whose code_verifier does not match the challenge, or is missing", async () => {
    const mock = startMock();
    const code = codeOf(await mock.authorize());

    const wrong = await mock.redeem(code, pkcePair().verifier);
    const missing = await mock.redeem(code, null);

    for (const response of [wrong, missing]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_grant",
        error_codes: [501481],
      });
    }
  });

  it("answers tokens for the first resource in the scopes, signed, with the person's claims", async () => {
    const mock = startMock();
    const app = mock.state.tenant.apps_registrations[0];
    if (app === undefined) throw new Error("The mock needs its app");
    Object.assign(app, {
      email_optional_claim: true,
    });
    const tokens = await mock.signIn("n-1");

    const keys = createLocalJWKSet(
      (await (
        await mock.app.request(
          `http://mock.test/${TEST_TENANT_ID}/discovery/v2.0/keys`,
        )
      ).json()) as JSONWebKeySet,
    );
    const { payload: access } = await jwtVerify(tokens.access_token, keys, {
      audience: POWER_BI_AUDIENCE,
      issuer: `http://mock.test/${TEST_TENANT_ID}/v2.0`,
    });
    expect(access).toMatchObject({
      tid: TEST_TENANT_ID,
      oid: ADA,
      scp: "Dataset.Read.All",
    });
    expect(tokens.scope).toBe(
      "https://analysis.windows.net/powerbi/api/Dataset.Read.All",
    );
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();
    expect(decodeJwt(tokens.id_token)).toMatchObject({
      aud: CLIENT_ID,
      tid: TEST_TENANT_ID,
      oid: ADA,
      email: "ada@example.test",
      preferred_username: "ada@example.test",
      name: "Ada Example",
      nonce: "n-1",
    });
  });

  it("answers no refresh token without offline_access and no ID token without openid", async () => {
    const mock = startMock();

    const response = await mock.redeem(
      codeOf(await mock.authorize({ scope: GRAPH_ME })),
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.access_token).toBeTruthy();
    expect(body).not.toHaveProperty("refresh_token");
    expect(body).not.toHaveProperty("id_token");
  });

  it("redeems a code once", async () => {
    const mock = startMock();
    const code = codeOf(await mock.authorize());

    expect((await mock.redeem(code)).status).toBe(200);
    const second = await mock.redeem(code);

    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({
      error: "invalid_grant",
      error_codes: [54005],
    });
  });

  it("refuses a code redeemed with another redirect_uri or by another client", async () => {
    const mock = startMock();
    addOtherClient(mock.state);
    const redeemed = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "web-secret",
      redirect_uri: TEST_REDIRECT_URI,
      code: codeOf(await mock.authorize()),
      code_verifier: mock.pkce.verifier,
    };

    const otherRedirect = await mock.token({
      ...redeemed,
      redirect_uri: "https://other.test/callback",
    });
    const otherClient = await mock.token({
      ...redeemed,
      client_id: OTHER_CLIENT_ID,
      client_secret: "other-secret",
    });

    for (const response of [otherRedirect, otherClient]) {
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "invalid_grant",
        error_codes: [70000],
      });
      expect(body.error_description).toContain(
        "issued to another client or for another redirect_uri",
      );
    }
  });

  it("refuses a wrong client secret", async () => {
    const mock = startMock();
    const code = codeOf(await mock.authorize());

    const response = await mock.token({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "nope",
      redirect_uri: TEST_REDIRECT_URI,
      code,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_client",
      error_codes: [7000215],
    });
  });
});

describe("authorize", () => {
  it("redirects with the code and the state for the acting person", async () => {
    const response = await startMock().authorize();

    expect(response.status).toBe(302);
    const parameters = redirectParameters(response);
    expect(parameters.get("state")).toBe("s1");
    expect(parameters.get("code")).toBeTruthy();
  });

  it("answers consent_required for a person whose consent was withdrawn", async () => {
    const response = await startMock(GRACE).authorize();

    const parameters = redirectParameters(response);
    expect(parameters.get("error")).toBe("consent_required");
    expect(parameters.get("error_description")).toContain("AADSTS65001");
    expect(parameters.get("state")).toBe("s1");
    expect(parameters.has("code")).toBe(false);
  });

  it("answers login_required when nobody is acting", async () => {
    const mock = startMock();
    mock.state.acting_user = null;

    expect(redirectParameters(await mock.authorize()).get("error")).toBe(
      "login_required",
    );
  });

  it("does not redirect to a redirect_uri the registration does not list", async () => {
    const response = await startMock().authorize({
      redirect_uri: "https://evil.test/callback",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("AADSTS50011");
  });

  it("refuses an unknown client", async () => {
    const response = await startMock().authorize({ client_id: "nobody" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("AADSTS700016");
  });

  it("requires a code_challenge with the S256 method, answering invalid_request to the registered address", async () => {
    const mock = startMock();
    const refused = [
      { code_challenge: undefined, code_challenge_method: undefined },
      { code_challenge: undefined },
      { code_challenge_method: undefined },
      { code_challenge_method: "plain" },
    ];

    for (const query of refused) {
      const response = await mock.authorize(query);

      expect(response.headers.get("location")).toContain(TEST_REDIRECT_URI);
      const parameters = redirectParameters(response);
      expect(parameters.get("error"), JSON.stringify(query)).toBe(
        "invalid_request",
      );
      expect(parameters.get("error_description")).toMatch(/^AADSTS\d+:/);
      expect(parameters.get("state")).toBe("s1");
      expect(parameters.has("code")).toBe(false);
    }
    expect(mock.state.codes.size).toBe(0);
  });

  it("answers for its own tenant only", async () => {
    const mock = startMock();

    const response = await mock.token(
      { grant_type: "client_credentials" },
      "someone-else",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      error_codes: [90002],
    });
  });
});

describe("client credentials", () => {
  const request = {
    grant_type: "client_credentials",
    client_id: SCANNER_ID,
    client_secret: "scanner-secret",
    scope: `${POWER_BI_AUDIENCE}/.default`,
  };

  it("answers an app-only token naming the service principal", async () => {
    const mock = startMock();

    const response = await mock.token(request);

    expect(response.status).toBe(200);
    const { access_token } = (await response.json()) as TokenResponse;
    expect(decodeJwt(access_token)).toMatchObject({
      aud: POWER_BI_AUDIENCE,
      tid: TEST_TENANT_ID,
      oid: "77777777-0000-4000-8000-0000000000a1",
      appid: SCANNER_ID,
    });
  });

  it("refuses a wrong secret and an unknown client with invalid_client", async () => {
    const mock = startMock();

    const wrong = await mock.token({ ...request, client_secret: "nope" });
    const unknown = await mock.token({ ...request, client_id: "nobody" });

    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      error: "invalid_client",
      error_codes: [7000215],
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({
      error: "invalid_client",
      error_codes: [700016],
    });
  });

  it("refuses a scope that is not a resource's .default", async () => {
    const response = await startMock().token({
      ...request,
      scope: "Dataset.Read.All",
    });

    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("refuses a grant type it does not know", async () => {
    const response = await startMock().token({ grant_type: "password" });

    expect(await response.json()).toMatchObject({
      error: "unsupported_grant_type",
    });
  });
});

describe("refresh token", () => {
  it("rotates: a use answers a new refresh token and spends the old one", async () => {
    const mock = startMock();
    const first = await mock.signIn();

    const rotated = await mock.refresh(first.refresh_token);
    const reuse = await mock.refresh(first.refresh_token);

    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    expect((await mock.refresh(second.refresh_token)).status).toBe(200);
  });

  it("redeems the same refresh token for Power BI or for Graph User.Read, by the scope asked", async () => {
    const mock = startMock();
    const first = await mock.signIn();

    const graph = (await (
      await mock.refresh(first.refresh_token, GRAPH_ME)
    ).json()) as TokenResponse;
    const powerBi = (await (
      await mock.refresh(graph.refresh_token)
    ).json()) as TokenResponse;

    expect(decodeJwt(graph.access_token)).toMatchObject({
      aud: GRAPH_AUDIENCE,
      scp: "User.Read",
      oid: ADA,
    });
    expect(decodeJwt(powerBi.access_token)).toMatchObject({
      aud: POWER_BI_AUDIENCE,
      scp: "Dataset.Read.All",
    });
  });

  it("refuses a scope the original request did not name", async () => {
    const mock = startMock();
    const first = await mock.signIn();

    const response = await mock.refresh(
      first.refresh_token,
      "https://graph.microsoft.com/Mail.Read",
    );

    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_codes: [70011],
    });
  });

  it("answers invalid_grant once the person's consent is revoked", async () => {
    const mock = startMock();
    const first = await mock.signIn();
    for (const person of mock.state.tenant.people) {
      if (person.object_id === ADA) person.revoked = true;
    }

    const response = await mock.refresh(first.refresh_token);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_grant",
      error_codes: [50173],
    });
  });

  it("refuses a refresh token redeemed by another client", async () => {
    const mock = startMock();
    addOtherClient(mock.state);
    const first = await mock.signIn();

    const response = await mock.refresh(first.refresh_token, undefined, {
      client_id: OTHER_CLIENT_ID,
      client_secret: "other-secret",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_grant",
      error_codes: [70000],
    });
  });

  it("refuses a refresh token nobody issued", async () => {
    const response = await startMock().refresh("made-up");

    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});
