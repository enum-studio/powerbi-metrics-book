import { errors, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { MockState } from "./context.js";

export const POWER_BI_AUDIENCE = "https://analysis.windows.net/powerbi/api";
export const GRAPH_AUDIENCE = "https://graph.microsoft.com";
export const TOKEN_LIFETIME_SECONDS = 3600;

const OPENID_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

/** Signs a token for the tenant; a negative lifetime makes an expired one for a test. */
export function signToken(
  state: MockState,
  issuer: string,
  audience: string,
  claims: JWTPayload,
  lifetime_seconds = TOKEN_LIFETIME_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tid: state.tenant.tenant_id, ver: "2.0", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: state.keys.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + lifetime_seconds)
    .sign(state.keys.private_key);
}

export type BearerResult = { claims: JWTPayload } | { error: string };

/**
 * Checks the signature, the audience and the expiry of the token in an
 * Authorization header. Every protected route of the mock starts here and
 * formats its own 401 from the message.
 */
export async function verifyBearer(
  state: MockState,
  authorization: string | undefined,
  audience: string,
): Promise<BearerResult> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { error: "Bearer access token is empty." };
  try {
    const { payload } = await jwtVerify(token, state.keys.public_key, {
      audience,
      algorithms: ["RS256"],
    });
    return { claims: payload };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { error: "Lifetime validation failed, the token is expired." };
    }
    if (
      error instanceof errors.JWTClaimValidationFailed &&
      error.claim === "aud"
    ) {
      return { error: "Access token validation failure. Invalid audience." };
    }
    if (error instanceof errors.JOSEError) {
      return { error: "Access token validation failure." };
    }
    throw error;
  }
}

/** A scope names its resource before the last slash; a bare one such as User.Read is Graph's. */
export function normalizeScope(scope: string): string {
  return OPENID_SCOPES.has(scope) || scope.includes("/")
    ? scope
    : `${GRAPH_AUDIENCE}/${scope}`;
}

export function shortScopeName(scope: string): string {
  return scope.slice(scope.lastIndexOf("/") + 1);
}

/**
 * The resource a token request is for: the first scope that is not an
 * OpenID one picks it, as Microsoft documents for requests naming several
 * resources. With none, the token is for Graph (the UserInfo endpoint).
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export function resourceOf(scope: string): {
  audience: string;
  scopes: string[];
} {
  const all = scope.split(" ").filter(Boolean).map(normalizeScope);
  const first = all.find((candidate) => !OPENID_SCOPES.has(candidate));
  if (!first) return { audience: GRAPH_AUDIENCE, scopes: all };
  const audience = first.slice(0, first.lastIndexOf("/"));
  return {
    audience,
    scopes: all.filter((candidate) => candidate.startsWith(`${audience}/`)),
  };
}

export function requestsScope(
  scope: string,
  name: "openid" | "offline_access" | "profile" | "email",
): boolean {
  return scope.split(" ").includes(name);
}
