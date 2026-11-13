import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { devStackUrl } from "./fixtures.ts";

export const REDIRECT = "https://client.sample.example/callback";
const clientName = () => `e2e client ${randomUUID().slice(0, 8)}`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/**
 * Registers an MCP client by dynamic registration, as a client does: from its
 * own process, with no cookie of the person's. Registering is limited to 10 a
 * minute per address and a whole run comes close, so a test registers at most
 * one and opens its consent as often as it needs.
 */
export async function registerClient(name = clientName()) {
  const registered = await fetch(`${devStackUrl()}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await registered.text();
  expect(registered.status, text).toBe(201);
  const { client_id } = JSON.parse(text) as { client_id: string };
  return { client_id, name };
}

/** Opens a registered client's authorization (PKCE) as the signed-in page, which lands on the consent. */
export async function openConsent(page: Page, client_id: string) {
  const base = devStackUrl();
  const state = randomUUID();
  await page.goto(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      scope: "mcp offline_access",
      state,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: `${base}/api/mcp`,
    }).toString()}`,
  );
  await expect(page).toHaveURL(
    (url) => url.origin === base && url.pathname === "/oauth/consent",
  );
  return state;
}

/** A new client, registered and at its consent. */
export async function authorize(page: Page) {
  const { client_id, name } = await registerClient();
  return { state: await openConsent(page, client_id), name };
}
