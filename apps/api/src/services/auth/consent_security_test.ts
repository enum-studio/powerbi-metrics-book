import { makeSignature } from "better-auth/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import { pkce, startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);

const f = startOAuth();
const BASE = TEST_PUBLIC_BASE_URL;

/** The secret Better Auth signs a consent request with. */
function apiSecret(): string {
  const { config } = f.deps;
  if (config.container !== "api") throw new Error("startOAuth builds the api");
  return config.auth_secret;
}

/** The consent screen's API path for the authorization `authorized` was sent to. */
async function consentPath(
  cookie: string,
  client_id: string,
  redirect_uri: string,
) {
  const authorized = await f.authorize(cookie, {
    response_type: "code",
    client_id,
    redirect_uri,
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/api/mcp`,
  });
  const page = new URL(authorized.headers.get("location") ?? "", BASE);
  expect(page.pathname).toBe("/oauth/consent");
  return `/api/v1/oauth/consent${page.search}`;
}

describe("the consent screen's API", () => {
  it("names the person, the client, its redirect, who registered it and when, and what it will and will not do", async () => {
    const { email, cookie } = await f.person();
    const client = f.client();
    const shown = await f.request(
      await consentPath(cookie, client.client_id, client.redirect_uri),
      { headers: { cookie } },
    );
    expect(shown.status).toBe(200);
    const body = (await shown.json()) as { client: { registered_at: string } };
    expect(body).toEqual({
      person: { email, name: email },
      client: {
        id: client.client_id,
        vouched_host: "client.example.org",
        claimed_name: "MCP client",
        registered_at: body.client.registered_at,
        registered_by: "metadata_document",
      },
      redirect: {
        scheme: "https",
        host: "client.example.org",
        private_use: false,
      },
      scopes: ["mcp", "offline_access"],
      will: [
        "Read and search the metrics book and the Power BI metadata you can see",
        "Run queries in Power BI as you, with your own access",
        "Ask questions and leave comments as you",
      ],
      will_not: [
        "Change the metrics book: metrics, terms, categories or conventions",
        "Reach anything your own roles and Power BI access do not",
      ],
    });
    expect(Date.now() - Date.parse(body.client.registered_at)).toBeLessThan(
      60_000,
    );
  });

  it("vouches for no host of a client that registered itself, and shows a private-use redirect as one", async () => {
    const { cookie } = await f.person();
    const redirect_uri = "com.example.sample:/callback";
    const registered = await f.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "native client",
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const shown = await f.request(
      await consentPath(cookie, client_id, redirect_uri),
      { headers: { cookie } },
    );
    expect(await shown.json()).toMatchObject({
      client: {
        vouched_host: null,
        claimed_name: "native client",
        registered_by: "dynamic_registration",
      },
      redirect: { scheme: "com.example.sample", host: null, private_use: true },
    });
  });

  it("refuses a request for a scope its will and will-not lists do not describe", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const path = await consentPath(
      cookie,
      client.client_id,
      client.redirect_uri,
    );
    // Better Auth signs only scopes the client registered; signed here as it
    // would sign a wider one, so the screen's own refusal is what is tested.
    const query = new URLSearchParams(new URL(path, BASE).search);
    query.set("scope", "mcp api offline_access");
    query.delete("sig");
    // Better Auth's canonical form: sorted by name, then value, by code unit.
    const canonical = new URLSearchParams(
      [...query.entries()].sort(([nameA, valueA], [nameB, valueB]) =>
        nameA === nameB ? (valueA < valueB ? -1 : 1) : nameA < nameB ? -1 : 1,
      ),
    );
    query.append("sig", await makeSignature(canonical.toString(), apiSecret()));
    const shown = await f.request(`/api/v1/oauth/consent?${query.toString()}`, {
      headers: { cookie },
    });
    expect(shown.status).toBe(400);
    expect(await shown.json()).toMatchObject({
      error: "invalid",
      message: expect.stringContaining("asks for api") as unknown,
    });
  });

  it("refuses a client whose metadata document names it unfitly, counting code points", async () => {
    const hosted = new Map<string, object>();
    const g = startOAuth({
      fetcher: {
        fetchFixed: () => Promise.reject(new Error("not used here")),
        fetchUntrusted: (url) => {
          const document = hosted.get(String(url));
          return document === undefined
            ? Promise.reject(new Error(`no document at ${String(url)}`))
            : Promise.resolve(Response.json(document));
        },
      },
    });
    const { cookie } = await g.person();
    const redirect_uri = "https://client.example.org/callback";
    // 101 code points that are 202 UTF-16 units, then the two kinds of character.
    for (const [index, client_name] of [
      "\u{1F600}".repeat(101),
      "client‮",
      "client\u0007",
    ].entries()) {
      const client_id = `https://client.example.org/unfit-${String(index)}/client.json`;
      hosted.set(client_id, {
        client_id,
        client_name,
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
      });
      const answer = await g.authorize(cookie, {
        response_type: "code",
        client_id,
        redirect_uri,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: `${BASE}/api/mcp`,
      });
      expect(answer.status, client_name).toBe(400);
      expect(await answer.json()).toMatchObject({ error: "invalid_client" });
    }
    // 100 code points pass, however many UTF-16 units they take.
    const client_id = "https://client.example.org/fit/client.json";
    hosted.set(client_id, {
      client_id,
      client_name: "\u{1F600}".repeat(100),
      redirect_uris: [redirect_uri],
      token_endpoint_auth_method: "none",
    });
    const fit = await g.authorize(cookie, {
      response_type: "code",
      client_id,
      redirect_uri,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: `${BASE}/api/mcp`,
    });
    expect(fit.status).toBe(302);
  });

  it("refuses to register a name of more than 100 characters, or one with a control or formatting character", async () => {
    for (const client_name of [
      "a".repeat(101),
      "client\u202E",
      "client\u0007",
    ]) {
      const registered = await f.request("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name,
          redirect_uris: ["https://registered.example.org/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(registered.status, client_name).toBe(400);
      expect(await registered.json()).toMatchObject({
        error: "invalid_client_metadata",
      });
    }
  });

  it("answers not_found to a request someone changed after it was signed", async () => {
    const { cookie } = await f.person();
    const client = f.client();
    const path = await consentPath(
      cookie,
      client.client_id,
      client.redirect_uri,
    );
    const changed = path.replace(
      encodeURIComponent("client.example.org/callback"),
      encodeURIComponent("evil.example.org/callback"),
    );
    expect(changed).not.toBe(path);
    expect((await f.request(changed, { headers: { cookie } })).status).toBe(
      404,
    );
  });
});
