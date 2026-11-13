import { describe, expect, it } from "vitest";
import { TEST_PUBLIC_BASE_URL, testConfig } from "../../../test/deps.js";
import type { SignInProvider } from "../../context.js";
import { issuerEndpoints, trustedOriginsFor } from "./better-auth.js";

/*
 * Better Auth's SSO plugin refuses an issuer on a private address unless its
 * origin is trusted. Only development and test trust the configured issuers,
 * so the tests can reach the mock on loopback; production trusts none. Every
 * endpoint sign-in calls must be on the issuer's own origin.
 */

const loopback: SignInProvider = {
  id: "sample_oidc",
  kind: "oidc",
  label: "OIDC",
  client_id: "sample-oidc",
  issuer: "http://127.0.0.1:4100/oidc",
};

describe("the origins Better Auth trusts", () => {
  it("are only the public base URL in production", () => {
    const config = testConfig("api", { NODE_ENV: "production" });
    expect(trustedOriginsFor(config, [loopback])).toEqual([
      TEST_PUBLIC_BASE_URL,
    ]);
  });

  it("add each OpenID Connect issuer in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const config = testConfig("api", { NODE_ENV });
      expect(trustedOriginsFor(config, [loopback]), NODE_ENV).toEqual([
        TEST_PUBLIC_BASE_URL,
        "http://127.0.0.1:4100",
      ]);
    }
  });
});

describe("the endpoints a provider's discovery document names", () => {
  const issuer = "https://idp.example.com/tenant";
  const document = {
    issuer,
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/keys",
    userinfo_endpoint: "https://idp.example.com/userinfo",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };

  it("are taken when each is on the issuer's origin over https", () => {
    expect(issuerEndpoints(document, issuer, false)).toEqual({
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      jwksEndpoint: document.jwks_uri,
      userInfoEndpoint: document.userinfo_endpoint,
    });
  });

  it("refuse the provider when sign-in would call another origin", () => {
    for (const changed of [
      { token_endpoint: "https://10.0.0.5/token" },
      { jwks_uri: "https://keys.example.net/keys" },
      { authorization_endpoint: "http://idp.example.com/authorize" },
    ])
      expect(() =>
        issuerEndpoints({ ...document, ...changed }, issuer, true),
      ).toThrow(/not on the issuer's origin/);
  });

  it("refuse plain http outside development and test, even on the issuer's origin", () => {
    const plain = "http://idp.example.com";
    const http = {
      ...document,
      authorization_endpoint: `${plain}/authorize`,
      token_endpoint: `${plain}/token`,
      jwks_uri: `${plain}/keys`,
    };
    expect(() => issuerEndpoints(http, plain, false)).toThrow(/over https/);
    expect(issuerEndpoints(http, plain, true).tokenEndpoint).toBe(
      `${plain}/token`,
    );
  });

  it("leave out a userinfo endpoint on another origin, so the ID token's claims serve", () => {
    const elsewhere = {
      ...document,
      userinfo_endpoint: "https://userinfo.example.net/oidc/userinfo",
    };
    expect(
      issuerEndpoints(elsewhere, issuer, false).userInfoEndpoint,
    ).toBeUndefined();
  });
});
