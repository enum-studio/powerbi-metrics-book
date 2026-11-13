import { createHash, randomBytes } from "node:crypto";
import { answered, type Browser, bearer, json } from "./browser.js";

/**
 * An MCP client as Claude or Cursor runs one, from nothing but the
 * connector's address: it is refused and told where the resource's metadata
 * is (RFC 9728), reads the authorization server's metadata (RFC 8414),
 * registers itself (RFC 7591), sends the person to authorize with PKCE, and
 * trades the code for a token. The person's consent is given through the api
 * with their browser session, as the consent screen does. Then JSON-RPC over
 * HTTP, one POST per message.
 */
export type McpClient = {
  client_id: string;
  /** tools/call; the tool's answer parsed from its one text block. */
  call<T>(tool: string, input?: Record<string, unknown>): Promise<T>;
};

const REDIRECT_URI = "http://127.0.0.1:53682/callback";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

export async function signInMcpClient(
  connector: string,
  person: Browser,
): Promise<McpClient> {
  const refused = await answered(
    await post(connector, { jsonrpc: "2.0", id: 0, method: "ping" }),
    401,
    "The connector without a token",
  );
  const challenge = refused.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  if (metadataUrl === undefined)
    throw new Error(
      `The connector's 401 named no resource_metadata: ${challenge}`,
    );
  const resource = await json<{
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
  }>(await fetch(metadataUrl), 200, `GET ${metadataUrl}`);
  const [issuer] = resource.authorization_servers;
  if (issuer === undefined)
    throw new Error(`${metadataUrl} named no authorization server`);
  // RFC 8414: the well-known segment goes between the host and the issuer's path.
  const issuerUrl = new URL(issuer);
  const serverMetadata = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`;
  const server = await json<{
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  }>(await fetch(serverMetadata), 200, `GET ${serverMetadata}`);
  if (server.issuer !== issuer)
    throw new Error(
      `${serverMetadata} names the issuer ${server.issuer}, not ${issuer}`,
    );

  const registered = await json<{ client_id: string }>(
    await post(server.registration_endpoint, {
      client_name: "end-to-end MCP client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    201,
    "Dynamic client registration",
  );

  const { verifier, challenge: code_challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(server.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT_URI,
    scope: resource.scopes_supported.join(" "),
    state,
    code_challenge,
    code_challenge_method: "S256",
    resource: resource.resource,
  }))
    authorize.searchParams.set(name, value);
  // Node's fetch says sec-fetch-mode: cors, so Better Auth answers in JSON.
  const { url: next } = await json<{ url: string }>(
    await person.send(authorize.href),
    200,
    "The authorization request, signed in",
  );
  const consentPage = new URL(next, person.origin);
  if (consentPage.pathname !== "/oauth/consent")
    throw new Error(
      `The authorization request sent the browser to ${consentPage.pathname}, not the consent screen`,
    );
  const request = consentPage.search.slice(1);
  await answered(
    await person.send(`/api/v1/oauth/consent?${request}`),
    200,
    "GET /api/v1/oauth/consent",
  );
  const { redirect_to } = await json<{ redirect_to: string }>(
    await person.send("/api/v1/oauth/consent", {
      method: "POST",
      json: { request, allow: true },
    }),
    200,
    "POST /api/v1/oauth/consent",
  );
  const back = new URL(redirect_to);
  const code = back.searchParams.get("code");
  if (`${back.origin}${back.pathname}` !== REDIRECT_URI || code === null)
    throw new Error(`The consent sent the browser to ${redirect_to}`);
  if (back.searchParams.get("state") !== state)
    throw new Error("The consent's redirect came back with another state");

  const tokens = await json<{ access_token: string }>(
    await fetch(
      server.token_endpoint,
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource: resource.resource,
      }),
    ),
    200,
    "The token request",
  );

  const send = (message: object) =>
    bearer(connector, tokens.access_token, { method: "POST", json: message });
  let id = 0;
  const rpc = async (method: string, parameters: unknown) => {
    id += 1;
    const answer = await json<{
      result?: unknown;
      error?: { code: number; message: string };
    }>(
      await send({ jsonrpc: "2.0", id, method, params: parameters }),
      200,
      `MCP ${method}`,
    );
    if (answer.error !== undefined)
      throw new Error(
        `MCP ${method} answered error ${String(answer.error.code)}: ${answer.error.message}`,
      );
    return answer.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pbmb-e2e", version: "0.1.0" },
  });
  await answered(
    await send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    202,
    "MCP notifications/initialized",
  );
  return {
    client_id: registered.client_id,
    async call<T>(tool: string, input: Record<string, unknown> = {}) {
      const result = (await rpc("tools/call", {
        name: tool,
        arguments: input,
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      const text = result.content[0]?.text ?? "";
      if (result.isError === true)
        throw new Error(`MCP ${tool} answered an error: ${text.slice(0, 600)}`);
      return JSON.parse(text) as T;
    },
  };
}
