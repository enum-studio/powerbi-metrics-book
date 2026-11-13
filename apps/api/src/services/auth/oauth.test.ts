import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import { startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);

const f = startOAuth();
const BASE = TEST_PUBLIC_BASE_URL;

describe("discovery", () => {
  it("serves the authorization server's metadata at the root and at the issuer's path", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      const answer = await f.request(path);
      expect(answer.status, path).toBe(200);
      const body = (await answer.json()) as Record<string, unknown>;
      expect(body, path).toMatchObject({
        issuer: `${BASE}/api/auth`,
        authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
        token_endpoint: `${BASE}/api/auth/oauth2/token`,
        registration_endpoint: `${BASE}/api/auth/oauth2/register`,
        device_authorization_endpoint: `${BASE}/api/auth/device/code`,
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["mcp", "api", "offline_access"],
        grant_types_supported: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
      });
      expect(body.token_endpoint_auth_methods_supported, path).toContain(
        "none",
      );
      // Nothing is advertised that no route here serves.
      for (const key of [
        "jwks_uri",
        "introspection_endpoint",
        "revocation_endpoint",
      ])
        expect(body, `${path} ${key}`).not.toHaveProperty(key);
    }
  });

  it("serves each protected resource's metadata", async () => {
    for (const [resource, scope, name] of [
      ["mcp", "mcp", "Power BI Metrics Book connector"],
      ["v1", "api", "Power BI Metrics Book API"],
    ] as const) {
      const answer = await f.request(
        `/.well-known/oauth-protected-resource/api/${resource}`,
      );
      expect(await answer.json()).toEqual({
        resource: `${BASE}/api/${resource}`,
        authorization_servers: [`${BASE}/api/auth`],
        scopes_supported: [scope, "offline_access"],
        bearer_methods_supported: ["header"],
        resource_name: name,
      });
    }
  });
});
