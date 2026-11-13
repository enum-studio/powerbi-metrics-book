import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { AuthorizationGrant, MockState } from "./context.js";

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256, RFC 7636 section 4.6. */
export function pkceMatches(challenge: string, verifier: string): boolean {
  return (
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}

export function redirectWith(
  c: Context,
  uri: string,
  parameters: Record<string, string | undefined>,
): Response {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return c.redirect(url.href, 302);
}

/** A client's id and secret, from the Authorization header or the form body. */
export function clientCredentials(
  c: Context,
  body: Record<string, string>,
): { client_id: string | undefined; secret: string | undefined } {
  const basic = c.req.header("authorization")?.match(/^Basic\s+(\S+)$/i)?.[1];
  if (!basic) return { client_id: body.client_id, secret: body.client_secret };
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const split = decoded.indexOf(":");
  return {
    client_id: decoded.slice(0, split),
    secret: decoded.slice(split + 1),
  };
}

export type CodeFailure = "unknown" | "spent" | "mismatch" | "pkce";

/** Spends an authorization code: once only, for the client and redirect it was issued to, with its PKCE verifier. */
export function redeemCode(
  state: MockState,
  provider: "microsoft" | "oidc",
  code: string | undefined,
  input: {
    client_id: string;
    redirect_uri: string | undefined;
    code_verifier: string | undefined;
  },
): { grant: AuthorizationGrant } | { failure: CodeFailure } {
  const grant = state.codes.get(code ?? "");
  if (!grant || grant.provider !== provider) return { failure: "unknown" };
  if (grant.spent) return { failure: "spent" };
  if (
    grant.client_id !== input.client_id ||
    grant.redirect_uri !== input.redirect_uri
  ) {
    return { failure: "mismatch" };
  }
  if (
    !input.code_verifier ||
    !pkceMatches(grant.code_challenge, input.code_verifier)
  ) {
    return { failure: "pkce" };
  }
  grant.spent = true;
  return { grant };
}
