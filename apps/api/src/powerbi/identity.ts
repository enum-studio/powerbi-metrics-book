import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppDeps, SecretName } from "../context.js";
import { ServiceError } from "../errors.js";
import { connectAgain } from "../config.js";
import { microsoftClaims } from "../services/auth/sign-in.js";
import {
  parseAnswer,
  parseJson,
  readJson,
  readMicrosoftError,
  upstreamFailure,
} from "./errors.js";

/*
 * Microsoft identity for both app registrations: client credentials for the
 * scanner and for the app's service principal, and a person's delegated
 * tokens through the authorization code flow with PKCE. Tokens and secrets
 * travel only to the token endpoint and never into a message.
 */

export type PowerBiDeps = Pick<
  AppDeps,
  "fetcher" | "settings" | "secrets" | "clock" | "config"
>;

const POWER_BI = "https://analysis.windows.net/powerbi/api";
const DELEGATED_SCOPE = {
  powerbi: `${POWER_BI}/Dataset.Read.All`,
  graph: "https://graph.microsoft.com/User.Read",
} as const;

/** One request names both resources; each token is then redeemed for one of them. */
export const CONNECTION_SCOPES = ["openid", "profile", "offline_access"].concat(
  Object.values(DELEGATED_SCOPE),
);

const REGISTRATIONS = {
  scanner: ["powerbi.scanner_client_id", "powerbi_scanner_client_secret"],
  app: ["powerbi.app_client_id", "powerbi_app_client_secret"],
} as const;
const RENEW_BEFORE_MS = 5 * 60_000;
const CLIENT_REFUSED = ["invalid_client", "unauthorized_client"];
const CLIENT_GRANT = "client_credentials";

export async function endpoint(
  deps: Pick<PowerBiDeps, "settings">,
  key: "powerbi.authority" | "powerbi.api_url" | "powerbi.graph_url",
  path: string,
): Promise<string> {
  const base = await deps.settings.get(key);
  return `${base.replace(/\/+$/, "")}${path}`;
}

function present(value: string | null, name: string): string {
  if (value !== null) return value;
  throw new ServiceError(
    "conflict",
    `Power BI is not set up: ${name} has no value here. Set it in the admin section.`,
  );
}

async function oauthUrl(deps: PowerBiDeps, action: "authorize" | "token") {
  const tenant = await deps.settings.get("powerbi.tenant_id");
  const path = `/${encodeURIComponent(present(tenant, "powerbi.tenant_id"))}/oauth2/v2.0/${action}`;
  return endpoint(deps, "powerbi.authority", path);
}

async function clientId(deps: PowerBiDeps, registration: "scanner" | "app") {
  const [setting] = REGISTRATIONS[registration];
  return present(await deps.settings.get(setting), setting);
}

/** Whether the scanner has a tenant, a client id and its secret here, so a sync can ask Power BI anything. */
export async function scannerSetUp(deps: PowerBiDeps): Promise<boolean> {
  const [setting, secret] = REGISTRATIONS.scanner;
  return (
    (await deps.settings.get("powerbi.tenant_id")) !== null &&
    (await deps.settings.get(setting)) !== null &&
    (await deps.secrets.read(secret)) !== null
  );
}

async function clientSecret(
  deps: PowerBiDeps,
  registration: "scanner" | "app",
) {
  const name: SecretName = REGISTRATIONS[registration][1];
  return present(await deps.secrets.read(name), name);
}

const appTokenAnswer = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});
const delegatedAnswer = appTokenAnswer.extend({
  scope: z.string(),
  refresh_token: z.string(),
  id_token: z.string().optional(),
});

/**
 * A token for the grant in the form, sent with the registration's own
 * credentials. Microsoft refusing those is the admin's to fix (conflict);
 * refusing a person's code or refresh token (invalid_grant) is theirs, by
 * connecting again.
 */
async function requestToken<S extends z.ZodType>(
  deps: PowerBiDeps,
  registration: "scanner" | "app",
  form: Record<string, string>,
  schema: S,
): Promise<z.output<S>> {
  const response = await deps.fetcher.fetchFixed(
    await oauthUrl(deps, "token"),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...form,
        client_id: await clientId(deps, registration),
        client_secret: await clientSecret(deps, registration),
      }),
    },
  );
  const body = await readJson(response);
  if (response.ok) return parseAnswer(schema, body, "Microsoft identity");
  const error = readMicrosoftError(body);
  // Microsoft's own sentence goes to the log through detail; the caller reads ours.
  const detail = { status: response.status, ...error };
  if (error !== null && CLIENT_REFUSED.includes(error.code)) {
    throw new ServiceError(
      "conflict",
      `Microsoft refused the ${registration} registration's client id or secret. Check them in the admin section.`,
      detail,
    );
  }
  if (error?.code === "invalid_grant" && form.grant_type !== CLIENT_GRANT) {
    throw new ServiceError(
      "needs_connection",
      `Your Power BI connection has ended: Microsoft no longer accepts it. ${connectAgain(deps.config)}`,
      detail,
    );
  }
  // The token request's own failure, whatever its status: not the admin API's.
  throw upstreamFailure("Microsoft identity", response.status, error, {
    token_request: true,
  });
}

/**
 * Client-credentials tokens, kept until five minutes before they expire, by
 * the token endpoint (authority and tenant), the client and the SHA-256 of
 * the secret: a changed secret or tenant asks Microsoft at once and is never
 * answered the old token. The key is never logged.
 */
const appTokens = new Map<string, { access_token: string; renewAt: number }>();

async function clientCredentialsToken(
  deps: PowerBiDeps,
  registration: "scanner" | "app",
): Promise<string> {
  const secretDigest = createHash("sha256")
    .update(await clientSecret(deps, registration))
    .digest("hex");
  const key = JSON.stringify([
    await oauthUrl(deps, "token"),
    await clientId(deps, registration),
    secretDigest,
  ]);
  const cached = appTokens.get(key);
  if (cached !== undefined && deps.clock().getTime() < cached.renewAt) {
    return cached.access_token;
  }
  const answer = await requestToken(
    deps,
    registration,
    { grant_type: CLIENT_GRANT, scope: `${POWER_BI}/.default` },
    appTokenAnswer,
  );
  const renewAt =
    deps.clock().getTime() + answer.expires_in * 1000 - RENEW_BEFORE_MS;
  appTokens.set(key, { access_token: answer.access_token, renewAt });
  return answer.access_token;
}

/** The scanner registration's token for the admin APIs. The worker alone reads its secret. */
export function scannerToken(deps: PowerBiDeps): Promise<string> {
  return clientCredentialsToken(deps, "scanner");
}

/** The app registration's service principal token, for service-account queries. */
export function appServicePrincipalToken(deps: PowerBiDeps): Promise<string> {
  return clientCredentialsToken(deps, "app");
}

export async function authorizationUrl(
  deps: PowerBiDeps,
  input: {
    state: string;
    code_challenge: string;
    login_hint: string;
    scopes: string[];
    redirect_uri: string;
  },
): Promise<string> {
  const url = new URL(await oauthUrl(deps, "authorize"));
  url.search = new URLSearchParams({
    client_id: await clientId(deps, "app"),
    response_type: "code",
    response_mode: "query",
    redirect_uri: input.redirect_uri,
    scope: input.scopes.join(" "),
    state: input.state,
    code_challenge: input.code_challenge,
    code_challenge_method: "S256",
    login_hint: input.login_hint,
  }).toString();
  return url.href;
}

export type DelegatedTokens = {
  access_token: string;
  expires_at: Date;
  refresh_token: string;
  scopes: string[];
};

/** The app registration's delegated grant: the code's redeem, or a refresh. */
async function delegated(
  deps: PowerBiDeps,
  form: Record<string, string>,
): Promise<DelegatedTokens & { id_token?: string }> {
  const answer = await requestToken(deps, "app", form, delegatedAnswer);
  return {
    ...answer,
    expires_at: new Date(deps.clock().getTime() + answer.expires_in * 1000),
    scopes: answer.scope.split(" ").filter(Boolean),
  };
}

const idTokenClaims = z.object({
  tid: z.string(),
  oid: z.string(),
  email: z.string().nullable().default(null),
  preferred_username: z.string().nullable().default(null),
});

export type RedeemedCode = DelegatedTokens & z.output<typeof idTokenClaims>;

/**
 * Redeems the code, and reads who connected from the ID token unverified:
 * it came in the token endpoint's own answer, which OpenID Connect Core
 * 3.1.3.7 accepts in place of checking its signature. Its issuer, audience,
 * tenant and expiry are checked as sign-in checks them.
 */
export async function redeemCode(
  deps: PowerBiDeps,
  input: { code: string; code_verifier: string; redirect_uri: string },
): Promise<RedeemedCode> {
  const { access_token, expires_at, refresh_token, scopes, id_token } =
    await delegated(deps, {
      grant_type: "authorization_code",
      ...input,
      scope: `openid profile offline_access ${DELEGATED_SCOPE.powerbi}`,
    });
  const payload = id_token?.split(".")[1];
  const claims =
    payload === undefined
      ? null
      : parseJson(Buffer.from(payload, "base64url").toString("utf8"));
  const who = parseAnswer(idTokenClaims, claims, "Microsoft identity");
  const issued = parseAnswer(
    z.record(z.string(), z.unknown()),
    claims,
    "Microsoft identity",
  );
  const expected = {
    tenant_id: await deps.settings.get("powerbi.tenant_id"),
    app_client_id: await deps.settings.get("powerbi.app_client_id"),
    authority: await deps.settings.get("powerbi.authority"),
    google_id: null,
  };
  if (microsoftClaims(issued, expected) === null)
    throw new ServiceError(
      "refused",
      who.tid === expected.tenant_id
        ? `Microsoft's ID token was not issued for this app. ${connectAgain(deps.config)}`
        : "This Microsoft account is not in the company's Power BI tenant.",
    );
  if (
    typeof issued.exp !== "number" ||
    issued.exp * 1000 <= deps.clock().getTime()
  )
    throw new ServiceError(
      "refused",
      `Microsoft's ID token has expired. ${connectAgain(deps.config)}`,
    );
  return { access_token, expires_at, refresh_token, scopes, ...who };
}

/** Spends the refresh token: Microsoft answers a new one, which replaces it. */
export async function refresh(
  deps: PowerBiDeps,
  refreshToken: string,
  resource: "powerbi" | "graph",
): Promise<DelegatedTokens> {
  const { access_token, expires_at, refresh_token, scopes } = await delegated(
    deps,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: `${DELEGATED_SCOPE[resource]} offline_access`,
    },
  );
  return { access_token, expires_at, refresh_token, scopes };
}
