import { createHash, randomBytes } from "node:crypto";
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createState, setActingUser } from "../entra/context.js";
import { GRAPH_AUDIENCE, signToken } from "../entra/tokens.js";
import { createTestTenant, TEST_REDIRECT_URI } from "../test-tenant.js";
import { oidcRoutes } from "./routes.js";

const ADA = "cccccccc-0000-4000-8000-000000000001";
const GRACE = "cccccccc-0000-4000-8000-000000000002";
const CLIENT_ID = "66666666-0000-4000-8000-000000000001";
const ORIGIN = "http://mock.test";

type TokenAnswer = {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
};

/** The entries of a record that have a value, so a test can leave a parameter out by setting it to undefined. */
function defined(record: Record<string, string | undefined>) {
  return Object.entries(record).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
}

function setup(acting_user = ADA) {
  const state = createState(createTestTenant());
  setActingUser(state, acting_user);
  const app = new Hono().route("/oidc", oidcRoutes(state));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  /** PKCE on by default, as the mock insists; a key set to undefined leaves that parameter out. */
  const authorize = async (query: Record<string, string | undefined> = {}) => {
    const url = new URL(`${ORIGIN}/oidc/authorize`);
    url.search = new URLSearchParams(
      defined({
        client_id: CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        response_type: "code",
        scope: "openid profile email",
        state: "st",
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...query,
      }),
    ).toString();
    const response = await app.request(url);
    return {
      response,
      parameters: new URL(response.headers.get("location") ?? ORIGIN)
        .searchParams,
    };
  };

  /** Sends the verifier of the default challenge unless the form says otherwise. */
  const token = (
    form: Record<string, string | undefined>,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${ORIGIN}/oidc/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(
        defined({
          grant_type: "authorization_code",
          redirect_uri: TEST_REDIRECT_URI,
          code_verifier: verifier,
          ...form,
        }),
      ),
    });

  return { app, state, authorize, token };
}

describe("generic OpenID Connect provider", () => {
  it("omits profile and email claims without their scopes", async () => {
    const { authorize, token } = setup();
    const { parameters } = await authorize({ scope: "openid" });
    const response = await token({
      client_id: CLIENT_ID,
      client_secret: "web-secret",
      code: parameters.get("code") ?? "",
    });
    const claims = decodeJwt(((await response.json()) as TokenAnswer).id_token);
    for (const key of ["name", "preferred_username", "email"])
      expect(claims).not.toHaveProperty(key);
  });

  it("publishes a discovery document whose endpoints sit under /oidc", async () => {
    const { app } = setup();

    const document = await (
      await app.request(`${ORIGIN}/oidc/.well-known/openid-configuration`)
    ).json();

    expect(document).toMatchObject({
      issuer: `${ORIGIN}/oidc`,
      authorization_endpoint: `${ORIGIN}/oidc/authorize`,
      token_endpoint: `${ORIGIN}/oidc/token`,
      jwks_uri: `${ORIGIN}/oidc/jwks`,
      userinfo_endpoint: `${ORIGIN}/oidc/userinfo`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("signs the person in: the code buys an ID token whose signature the JWKS proves, and an access token userinfo accepts", async () => {
    const { app, authorize, token } = setup();
    const { parameters } = await authorize({ nonce: "n-1" });
    expect(parameters.get("state")).toBe("st");

    const response = await token({
      client_id: CLIENT_ID,
      client_secret: "web-secret",
      code: parameters.get("code") ?? "",
    });

    expect(response.status).toBe(200);
    const tokens = (await response.json()) as TokenAnswer;
    const keys = createLocalJWKSet(
      (await (
        await app.request(`${ORIGIN}/oidc/jwks`)
      ).json()) as JSONWebKeySet,
    );
    const { payload } = await jwtVerify(tokens.id_token, keys, {
      issuer: `${ORIGIN}/oidc`,
      audience: CLIENT_ID,
    });
    expect(payload).toMatchObject({
      sub: ADA,
      email: "ada@example.test",
      email_verified: true,
      name: "Ada Example",
      nonce: "n-1",
    });
    expect(payload.groups).toContain("99999999-0000-4000-8000-000000000001");
    const userinfo = await app.request(`${ORIGIN}/oidc/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await userinfo.json()).toMatchObject({
      sub: ADA,
      email: "ada@example.test",
    });
  });

  it("takes the client's credentials from a Basic header as well as the form", async () => {
    const { authorize, token } = setup();
    const { parameters } = await authorize();

    const response = await token(
      { code: parameters.get("code") ?? "" },
      {
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:web-secret`).toString("base64")}`,
      },
    );

    expect(response.status).toBe(200);
  });

  it("refuses a wrong or missing verifier, a second use of the code and a wrong secret", async () => {
    const { authorize, token } = setup();
    const credentials = { client_id: CLIENT_ID, client_secret: "web-secret" };
    const unverified = (await authorize()).parameters.get("code") ?? "";
    const code = (await authorize()).parameters.get("code") ?? "";

    const wrongVerifier = await token({
      ...credentials,
      code: unverified,
      code_verifier: "wrong",
    });
    const missingVerifier = await token({
      ...credentials,
      code: unverified,
      code_verifier: undefined,
    });
    const wrongSecret = await token({
      ...credentials,
      client_secret: "nope",
      code,
    });
    await token({ ...credentials, code });
    const second = await token({ ...credentials, code });

    for (const refused of [wrongVerifier, missingVerifier]) {
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
    }
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toMatchObject({ error: "invalid_client" });
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("answers access_denied for a revoked person and does not redirect to an unregistered address", async () => {
    const revoked = await setup(GRACE).authorize();
    const stranger = await setup().authorize({
      redirect_uri: "https://evil.test/cb",
    });

    expect(revoked.parameters.get("error")).toBe("access_denied");
    expect(stranger.response.status).toBe(400);
    expect(stranger.response.headers.get("location")).toBeNull();
  });

  it("requires a code_challenge with the S256 method, answering invalid_request to the registered address", async () => {
    const { authorize, state } = setup();
    const refused = [
      { code_challenge: undefined, code_challenge_method: undefined },
      { code_challenge: undefined },
      { code_challenge_method: undefined },
      { code_challenge_method: "plain" },
    ];

    for (const query of refused) {
      const { response, parameters } = await authorize(query);

      expect(response.headers.get("location")).toContain(TEST_REDIRECT_URI);
      expect(parameters.get("error"), JSON.stringify(query)).toBe(
        "invalid_request",
      );
      expect(parameters.get("error_description")).toBeTruthy();
      expect(parameters.get("state")).toBe("st");
      expect(parameters.has("code")).toBe(false);
    }
    expect(state.codes.size).toBe(0);
  });

  it("answers 401 invalid_token from userinfo for a token it did not sign", async () => {
    const { app } = setup();
    const other = setup();
    const { parameters } = await other.authorize();
    const tokens = (await (
      await other.token({
        client_id: CLIENT_ID,
        client_secret: "web-secret",
        code: parameters.get("code") ?? "",
      })
    ).json()) as TokenAnswer;

    const response = await app.request(`${ORIGIN}/oidc/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("answers 401 invalid_token from userinfo for an expired token and for a token meant for another audience", async () => {
    const { app, state } = setup();
    const issuer = `${ORIGIN}/oidc`;
    const claims = { sub: ADA };
    const userinfo = async (access_token: string) =>
      app.request(`${issuer}/userinfo`, {
        headers: { authorization: `Bearer ${access_token}` },
      });

    const valid = await userinfo(
      await signToken(state, issuer, issuer, claims),
    );
    const expired = await userinfo(
      await signToken(state, issuer, issuer, claims, -60),
    );
    const otherAudience = await userinfo(
      await signToken(state, issuer, GRAPH_AUDIENCE, claims),
    );

    expect(valid.status).toBe(200);
    for (const [response, reason] of [
      [expired, "expired"],
      [otherAudience, "audience"],
    ] as const) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "invalid_token",
      );
      const body = (await response.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_token");
      expect(body.error_description).toContain(reason);
    }
  });
});
