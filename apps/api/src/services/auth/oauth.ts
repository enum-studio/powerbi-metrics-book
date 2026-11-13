import { createHash, webcrypto } from "node:crypto";
import {
  type ClientDiscovery,
  type OAuthClient,
  oauthClientMetadataSchema,
  oauthProvider,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import {
  isForbiddenCimdClientMetadataField,
  registerClientMetadataDocument,
} from "@better-auth/oauth-provider/internal";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { and, eq, inArray, lte } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import {
  jwks,
  oauthClient,
  oauthConsent,
  oauthConsentUse,
  oauthRefreshToken,
  user,
} from "../../db/schema/auth.js";
import { ServiceError } from "../../errors.js";
import type { Auth } from "./better-auth.js";
import {
  CLI_CLIENT_ID,
  noteAuthorization,
  noteGrantUse,
  pruneIdleClients,
  revokeGrantOf,
} from "./grants.js";
import type { Person } from "./roles.js";

/*
 * Better Auth's OAuth provider, for MCP clients and the CLI. Each grant is a
 * person's consent to one client (oauth_consent): an access or refresh token
 * works only while a consent made no later than the token exists, so removing
 * the consent stops every token of the grant at once.
 */

/** The two protected resources: the connector, and the REST API the CLI uses. */
export type ResourceName = "mcp" | "v1";
const RESOURCE_PATHS = { mcp: "/api/mcp", v1: "/api/v1" } as const;
/** The scope a token needs for each resource. */
export const RESOURCE_SCOPES = { mcp: "mcp", v1: "api" } as const;
export const OFFLINE_ACCESS = "offline_access";

/** PUBLIC_BASE_URL with no trailing slash. */
export function baseOf(base: URL): string {
  return base.href.replace(/\/$/, "");
}

export function resourceUri(base: URL, name: ResourceName): string {
  return `${baseOf(base)}${RESOURCE_PATHS[name]}`;
}

/** The issuer of every token, RFC 9207's `iss`: Better Auth's base URL. */
export function issuerOf(base: URL): string {
  return `${baseOf(base)}/api/auth`;
}

/** Which resource a request path belongs to, if any. */
export function resourceOfPath(path: string): ResourceName | null {
  for (const name of ["mcp", "v1"] as const) {
    const prefix = RESOURCE_PATHS[name];
    if (path === prefix || path.startsWith(`${prefix}/`)) return name;
  }
  return null;
}

/** Refresh tokens and codes are stored as SHA-256 digests; oauth.ts reads them by the same digest. */
export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Ten logins a minute from one address covers an office behind one NAT; a client polls the device grant every 5 seconds. */
const TOKEN_RULE = { window: 60, max: 60 };
const REGISTER_RULE = { window: 60, max: 10 };

const ACCESS_TOKEN_SECONDS = 60 * 60;
const ACCESS_TOKEN_TYPE = "at+jwt";
const METADATA_DOCUMENT = "client_id_metadata_document";
/** How long a client's fetched metadata document serves before it is fetched again. */
const DOCUMENT_FRESH_MS = 24 * 60 * 60 * 1000;

/** The JWT signer and the OAuth provider, as createAuth adds them to Better Auth. */
export function oauthPlugins(deps: AppDeps) {
  const base = deps.config.public_base_url;
  const mcp = resourceUri(base, "mcp");
  return [
    jwt({
      jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
      jwt: { issuer: issuerOf(base) },
      // A session's JWT is never handed to the browser.
      disableSettingJwtHeader: true,
    }),
    oauthProvider({
      loginPage: `${baseOf(base)}/sign-in`,
      consentPage: `${baseOf(base)}/oauth/consent`,
      scopes: [RESOURCE_SCOPES.mcp, RESOURCE_SCOPES.v1, OFFLINE_ACCESS],
      grantTypes: ["authorization_code", "refresh_token"],
      resources: [mcp, resourceUri(base, "v1")],
      enforcePerClientResources: true,
      clientRegistrationDefaultResources: [mcp],
      clientRegistrationDefaultScopes: [RESOURCE_SCOPES.mcp, OFFLINE_ACCESS],
      clientRegistrationDefaultApplicationType: "infer",
      // Registering grants nothing: every client's first authorization asks the person.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
      refreshTokenReuseInterval: 0,
      storeTokens: { hash: digestToken },
      rateLimit: { token: TOKEN_RULE, register: REGISTER_RULE },
      extensions: [{ clientDiscovery: metadataDocuments(deps) }],
    }),
  ];
}

function invalidClient(description: string): APIError {
  return new APIError("BAD_REQUEST", {
    error: "invalid_client",
    error_description: description,
  });
}

/** A client_id that names its own metadata document: https, a path, and nothing a URL parser would rewrite. */
function isDocumentUrl(clientId: string): boolean {
  if (!URL.canParse(clientId)) return false;
  const url = new URL(clientId);
  return (
    url.protocol === "https:" &&
    url.pathname !== "/" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.href === clientId
  );
}

/**
 * Client ID Metadata Documents: a client_id that is an https URL is the
 * client's own metadata, fetched through the guarded fetcher's profile for
 * URLs someone else chose, and stored as a client that holds no grant.
 */
function metadataDocuments(deps: AppDeps): ClientDiscovery {
  return {
    id: METADATA_DOCUMENT,
    matches: isDocumentUrl,
    resolve: async (endpoint, clientId, existing) => {
      const fetchedAt = existing?.updatedAt ?? existing?.createdAt;
      if (
        existing !== null &&
        fetchedAt !== undefined &&
        deps.clock().getTime() - new Date(fetchedAt).getTime() <
          DOCUMENT_FRESH_MS
      )
        return existing;
      const metadata = await fetchDocument(
        deps,
        clientId,
        endpoint.request?.headers.get(REQUEST_ID) ?? null,
      );
      if (existing === null) await pruneIdleClients(deps.db, deps.clock());
      const provider = endpoint.context.getPlugin("oauth-provider");
      if (provider === null)
        throw new Error("The OAuth provider plugin is not installed.");
      const { client } = await registerClientMetadataDocument(
        endpoint,
        provider.options,
        {
          metadata,
          clientId,
          clientDiscoveryId: METADATA_DOCUMENT,
          ...(existing === null ? {} : { existingClient: existing }),
        },
      );
      return client;
    },
    fetchClientMetadataResource: (
      input: string | URL | Request,
      init?: RequestInit,
    ) =>
      deps.fetcher.fetchUntrusted(
        input instanceof Request ? input.url : input,
        init,
      ),
    discoveryMetadata: { client_id_metadata_document_supported: true },
  };
}

/** The header app.ts gives the request Better Auth sees, naming the api's own request id. */
export const REQUEST_ID = "x-request-id";

/** The document at the client's URL. Why a fetch failed goes to the log only: answered, it would say what a host resolves to inside the network. */
async function fetchDocument(
  deps: AppDeps,
  clientId: string,
  request_id: string | null,
): Promise<OAuthClient> {
  let body: unknown;
  try {
    const response = await deps.fetcher.fetchUntrusted(clientId, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`it answered ${String(response.status)}`);
    body = await response.json();
  } catch (error) {
    deps.logger.warn("a client metadata document could not be read", {
      request_id,
      client_id: clientId,
      error: String(error),
    });
    throw invalidClient("The client's metadata document could not be read.");
  }
  const parsed = oauthClientMetadataSchema.safeParse(body);
  if (!parsed.success)
    throw invalidClient(`${clientId} is not a client metadata document.`);
  const { redirect_uris, ...document } = parsed.data;
  if (document.client_id !== clientId)
    throw invalidClient(`${clientId} names another client_id.`);
  const reserved = Object.keys(parsed.data).filter(
    isForbiddenCimdClientMetadataField,
  );
  if (reserved.length > 0)
    throw invalidClient(
      `${clientId} sets ${reserved.join(", ")}, which only this server sets.`,
    );
  if (redirect_uris === undefined || redirect_uris.length === 0)
    throw invalidClient(`${clientId} names no redirect_uris.`);
  if (!fitClientName(document.client_name))
    throw invalidClient(`${clientId}: ${UNFIT_CLIENT_NAME}`);
  return { ...document, redirect_uris };
}

/** A JSON object from text someone else wrote, or null when it is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodePart(part: string | undefined): Record<string, unknown> | null {
  return part === undefined
    ? null
    : parseObject(Buffer.from(part, "base64url").toString());
}

/** The claims of an access token this api signed, or null: only EdDSA, only an access token, only a key in jwks. */
async function signedClaims(
  deps: AppDeps,
  token: string,
): Promise<Record<string, unknown> | null> {
  const [head, body, signature, ...rest] = token.split(".");
  const header = decodePart(head);
  const claims = decodePart(body);
  if (
    rest.length > 0 ||
    signature === undefined ||
    header === null ||
    claims === null ||
    header.alg !== "EdDSA" ||
    header.typ !== ACCESS_TOKEN_TYPE ||
    typeof header.kid !== "string"
  )
    return null;
  const [key] = await deps.db
    .select({ publicKey: jwks.publicKey })
    .from(jwks)
    .where(eq(jwks.id, header.kid));
  if (key === undefined) return null;
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    JSON.parse(key.publicKey) as webcrypto.JsonWebKey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${head ?? ""}.${body ?? ""}`),
  );
  return valid ? claims : null;
}

export type BearerVerdict =
  | { ok: true; person: Person; name: string; client_id: string }
  | { ok: false; refusal: "invalid_token" | "insufficient_scope" };

const INVALID_TOKEN = { ok: false, refusal: "invalid_token" } as const;

/**
 * An access token for one resource: this api's signature, its issuer, the
 * resource in `aud`, unexpired by deps.clock, and a grant still standing.
 * Only then does the scope decide. A token that passes notes its grant's
 * use, and is refused if a revoke ended the grant while it was checked.
 */
export async function verifyAccessToken(
  deps: AppDeps,
  token: string,
  resource: ResourceName,
): Promise<BearerVerdict> {
  const claims = await signedClaims(deps, token);
  if (claims === null) return INVALID_TOKEN;
  const { iss, aud, exp, iat, sub, azp, scope } = claims;
  const audiences: unknown[] = Array.isArray(aud) ? aud : [aud];
  const base = deps.config.public_base_url;
  if (
    iss !== issuerOf(base) ||
    !audiences.includes(resourceUri(base, resource)) ||
    typeof exp !== "number" ||
    exp * 1000 <= deps.clock().getTime() ||
    typeof iat !== "number" ||
    typeof sub !== "string" ||
    typeof azp !== "string" ||
    typeof scope !== "string"
  )
    return INVALID_TOKEN;
  const grant = await standingGrant(deps, azp, sub, new Date(iat * 1000));
  if (grant === undefined) return INVALID_TOKEN;
  const [row] = await deps.db
    .select({
      id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      name: user.name,
    })
    .from(user)
    .where(eq(user.id, sub));
  if (row === undefined) return INVALID_TOKEN;
  if (!scope.split(" ").includes(RESOURCE_SCOPES[resource]))
    return { ok: false, refusal: "insufficient_scope" };
  if (!(await noteGrantUse(deps.db, grant, deps.clock()))) return INVALID_TOKEN;
  const { name, ...person } = row;
  return { ok: true, person, name, client_id: azp };
}

/**
 * The standing grant a token issued at `issuedAt` belongs to: a consent to
 * this client made no later, with when it was last used.
 */
async function standingGrant(
  deps: AppDeps,
  client_id: string,
  user_id: string,
  issuedAt: Date,
): Promise<{ id: string; last_used_at: Date | null } | undefined> {
  const [consent] = await deps.db
    .select({ id: oauthConsent.id, last_used_at: oauthConsentUse.last_used_at })
    .from(oauthConsent)
    .leftJoin(oauthConsentUse, eq(oauthConsentUse.consent_id, oauthConsent.id))
    .where(
      and(
        eq(oauthConsent.clientId, client_id),
        eq(oauthConsent.userId, user_id),
        lte(oauthConsent.createdAt, issuedAt),
      ),
    )
    .limit(1);
  return consent;
}

/** An OAuth request's form fields, unconsumed, or null when not form-encoded (RFC 6749 section 3.2). */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type")?.split(";")[0];
  if (type?.trim().toLowerCase() !== "application/x-www-form-urlencoded")
    return null;
  return new URLSearchParams(await request.clone().text());
}

/** A field sent twice, which this api and Better Auth could read differently: refused, as RFC 6749 says. */
export function repeatsAField(form: URLSearchParams): boolean {
  const names = [...form.keys()];
  return new Set(names).size !== names.length;
}

export function oauthError(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

export const NOT_A_FORM = "Send the fields form-encoded, each once.";
/** More fields than any token request carries (grant, code, verifier, client and its assertion, resource, scope...). */
const MOST_TOKEN_FIELDS = 12;
const SIGN_IN_ENDED = "This sign-in ended. Sign in again.";

async function revokeForReuse(
  deps: AppDeps,
  stored: { clientId: string; userId: string },
) {
  await revokeGrantOf(deps.db, stored.clientId, stored.userId);
  deps.logger.warn("a used refresh token came back; its grant is revoked", {
    client_id: stored.clientId,
    user_id: stored.userId,
  });
}

/**
 * A used refresh token, or one whose grant ended, revokes the grant however
 * the request is shaped, and so does losing a race for one (read again
 * after Better Auth answers). Better Auth alone leaves the JWTs it signed
 * working, and can leave a racing successor (its issue #11317).
 */
async function guardToken(
  deps: AppDeps,
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  const form = await readForm(request);
  const presented = form?.getAll("refresh_token") ?? [];
  // Bounded before any database work, so one request cannot ask for more.
  if (
    form === null ||
    [...form.keys()].length > MOST_TOKEN_FIELDS ||
    presented.length > 2
  )
    return oauthError("invalid_request", NOT_A_FORM);
  const stored =
    presented.length === 0
      ? []
      : await deps.db
          .select()
          .from(oauthRefreshToken)
          .where(inArray(oauthRefreshToken.token, presented.map(digestToken)));
  let revoked = false;
  for (const token of stored)
    if (
      token.revoked !== null ||
      (await standingGrant(
        deps,
        token.clientId,
        token.userId,
        token.createdAt,
      )) === undefined
    ) {
      await revokeForReuse(deps, token);
      revoked = true;
    }
  if (revoked) return oauthError("invalid_grant", SIGN_IN_ENDED);
  if (repeatsAField(form)) return oauthError("invalid_request", NOT_A_FORM);
  const before =
    form.get("grant_type")?.trim() === "refresh_token" ? stored[0] : undefined;
  const response = await forward(request);
  if (before === undefined || response.status !== 400) return response;
  const answer = parseObject(await response.clone().text());
  const [after] = await deps.db
    .select({ revoked: oauthRefreshToken.revoked })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.id, before.id));
  if (answer?.error === "invalid_grant" && after?.revoked !== null)
    await revokeForReuse(deps, before);
  return response;
}

/** Registration fields that would make the api fetch a URL outside the guarded fetcher, or call one later. */
const UNFETCHED_FIELDS = [
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "jwks_uri",
  "post_logout_redirect_uris",
];

const CLIENT_NAME_MAX = 100;
const UNFIT_CLIENT_NAME = `client_name must be at most ${String(CLIENT_NAME_MAX)} characters, with no control or formatting characters.`;

/**
 * The consent screen shows a client's name to the person deciding. A
 * formatting character (U+202E reverses the text after it) or a control
 * character could make it, or the words beside it, read as something else.
 * Registered or from a metadata document, a name passes this or the client
 * is refused. Characters are code points.
 */
function fitClientName(name: unknown): boolean {
  return (
    typeof name !== "string" ||
    (Array.from(name).length <= CLIENT_NAME_MAX &&
      !/[\p{Cc}\p{Cf}]/u.test(name))
  );
}

async function guardRegister(
  deps: AppDeps,
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  const metadata = request.headers.get("content-type")?.includes("json")
    ? parseObject(await request.clone().text())
    : null;
  if (metadata === null)
    return oauthError("invalid_client_metadata", "Send the metadata as JSON.");
  const named = UNFETCHED_FIELDS.filter((field) => field in metadata);
  if (named.length > 0)
    return oauthError(
      "invalid_client_metadata",
      `This server takes no ${named.join(", ")}.`,
    );
  if (!fitClientName(metadata.client_name))
    return oauthError("invalid_client_metadata", UNFIT_CLIENT_NAME);
  const response = await forward(request);
  if (response.status === 201) await pruneIdleClients(deps.db, deps.clock());
  return response;
}

/**
 * Better Auth's OAuth endpoints with what this api adds around them: an
 * authorization must name its resource, the token endpoint is guarded
 * (guardToken), and registration takes no field that fetches.
 */
export async function guardOAuth(
  deps: AppDeps,
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/oauth2/authorize") {
    // An empty resource reads to Better Auth as none, and a token without an audience.
    const resources = url.searchParams.getAll("resource");
    if (resources.length === 0 || resources.includes(""))
      return oauthError(
        "invalid_target",
        "Name the resource this client will use, as resource=<this site>/api/mcp.",
      );
    const response = await forward(request);
    const [client_id, ...more] = url.searchParams.getAll("client_id");
    if (client_id !== undefined && more.length === 0)
      await noteAuthorization(deps.db, client_id, deps.clock());
    return response;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/oauth2/token")
    return guardToken(deps, request, forward);
  if (request.method === "POST" && url.pathname === "/api/auth/oauth2/register")
    return guardRegister(deps, request, forward);
  return forward(request);
}

/** The browser request a service acts for: its headers and its connection's address. */
export type Caller = { headers: Headers; peer: string | null };

/**
 * Asks Better Auth's `path` as the signed-in person the caller is, from the
 * caller's address, so Better Auth's rate limits count the person's own
 * requests. A body makes it a POST.
 */
export async function askAsPerson(
  deps: AppDeps,
  auth: Auth,
  caller: Caller,
  path: string,
  body?: object,
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "origin", "x-forwarded-for", "x-real-ip"]) {
    const value = caller.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const url = `${issuerOf(deps.config.public_base_url)}${path}`;
  return auth.handle(
    body === undefined
      ? new Request(url, { headers })
      : new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
    caller.peer,
  );
}

/** The scopes an MCP client's consent may ask for: the connector, and staying signed in. */
const CONSENT_SCOPES: ReadonlySet<string> = new Set([
  RESOURCE_SCOPES.mcp,
  OFFLINE_ACCESS,
]);

const NO_CONSENT_REQUEST =
  "This sign-in request expired or is not valid. Start again from your app.";

/** Where the code goes: a private-use scheme (`cursor:`) is shown as one, and a URI with no host has a null host, never "". */
function redirectOf(uri: string) {
  if (!URL.canParse(uri)) return null;
  const url = new URL(uri);
  const scheme = url.protocol.replace(/:$/, "");
  return {
    scheme,
    host: url.host === "" ? null : url.host,
    private_use: scheme !== "https" && scheme !== "http",
  };
}

/**
 * The consent screen, from the query Better Auth signed. Only `vouched_host`
 * is checked (it serves the metadata document); the name is claimed.
 */
export async function consentRequest(deps: AppDeps, query: string) {
  if (
    deps.config.container !== "api" ||
    !(await verifyOAuthQueryParams(query, deps.config.auth_secret))
  )
    throw new ServiceError("not_found", NO_CONSENT_REQUEST);
  const fields = new URLSearchParams(query);
  const [client] = await deps.db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, fields.get("client_id") ?? ""));
  if (client === undefined)
    throw new ServiceError("not_found", NO_CONSENT_REQUEST);
  const vouched = client.clientDiscoveryId === METADATA_DOCUMENT;
  // The will and will-not lists below describe these scopes alone, so no other is put to the person.
  const scopes = (fields.get("scope") ?? "").split(" ").filter(Boolean);
  const undescribed = scopes.filter((scope) => !CONSENT_SCOPES.has(scope));
  if (undescribed.length > 0)
    throw new ServiceError(
      "invalid",
      `This app asks for ${undescribed.join(", ")}, which this screen cannot describe. Ask it to request only mcp and offline_access.`,
    );
  return {
    client: {
      id: client.clientId,
      vouched_host: vouched ? new URL(client.clientId).host : null,
      claimed_name: client.name,
      registered_at: client.createdAt?.toISOString() ?? null,
      registered_by: vouched
        ? "metadata_document"
        : client.clientId === CLI_CLIENT_ID
          ? "this_api"
          : "dynamic_registration",
    },
    redirect: redirectOf(fields.get("redirect_uri") ?? ""),
    scopes,
    will: [
      "Read and search the metrics book and the Power BI metadata you can see",
      "Run queries in Power BI as you, with your own access",
      "Ask questions and leave comments as you",
    ],
    will_not: [
      "Change the metrics book: metrics, terms, categories or conventions",
      "Reach anything your own roles and Power BI access do not",
    ],
  };
}

/**
 * Allow or Deny, through Better Auth's consent endpoint as the signed-in
 * person. Answers where the browser goes next: the client's redirect URI,
 * with a code or with access_denied.
 */
export async function answerConsent(
  deps: AppDeps,
  auth: Auth,
  caller: Caller,
  query: string,
  allow: boolean,
): Promise<string> {
  const answer = await askAsPerson(deps, auth, caller, "/oauth2/consent", {
    accept: allow,
    oauth_query: query,
  });
  const body = parseObject(await answer.text());
  if (!answer.ok || typeof body?.url !== "string")
    throw new ServiceError("not_found", NO_CONSENT_REQUEST);
  return body.url;
}

/** The RFC 9728 document for one resource. */
export function protectedResourceMetadata(base: URL, resource: ResourceName) {
  return {
    resource: resourceUri(base, resource),
    authorization_servers: [issuerOf(base)],
    scopes_supported: [RESOURCE_SCOPES[resource], OFFLINE_ACCESS],
    bearer_methods_supported: ["header"],
    resource_name:
      resource === "mcp"
        ? "Power BI Metrics Book connector"
        : "Power BI Metrics Book API",
  };
}

export function resourceMetadataUrl(base: URL, resource: ResourceName): string {
  return `${baseOf(base)}/.well-known/oauth-protected-resource${RESOURCE_PATHS[resource]}`;
}

/** What Better Auth advertises and no route here serves: keys, introspection, revocation, back-channel logout, DPoP. */
const NOT_SERVED = /^(jwks_uri|introspection_|revocation_|backchannel_|dpop_)/;

/** RFC 8414 metadata as Better Auth builds it, without what no route serves. */
export function servedMetadata(metadata: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !NOT_SERVED.test(key)),
  );
}

/**
 * On /api/mcp and /api/v1, a 401 says where the resource's metadata is
 * (RFC 9728), and a valid token without the resource's scope is answered 403
 * insufficient_scope (RFC 6750). Registered ahead of authenticate, it reads
 * what authenticate left in c.var.bearer_refusal.
 */
export function bearerChallenge(base: URL): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const resource = resourceOfPath(c.req.path);
    if (resource === null || c.res.status !== 401) return;
    const refusal = c.get("bearer_refusal");
    const metadata = `resource_metadata="${resourceMetadataUrl(base, resource)}"`;
    if (refusal === "insufficient_scope") {
      const scope = RESOURCE_SCOPES[resource];
      c.res = Response.json(
        {
          error: "insufficient_scope",
          message: `This token does not cover ${RESOURCE_PATHS[resource]}. Sign in again and grant the ${scope} scope.`,
        },
        {
          status: 403,
          headers: {
            "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}", ${metadata}`,
          },
        },
      );
      return;
    }
    const error = refusal === "invalid_token" ? `error="invalid_token", ` : "";
    c.res.headers.set("www-authenticate", `Bearer ${error}${metadata}`);
  };
}
