import { createHash } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import {
  computeDiscoveryUrl,
  type OIDCConfig,
  type OIDCDiscoveryDocument,
  selectTokenEndpointAuthMethod,
  sso,
  validateDiscoveryDocument,
} from "@better-auth/sso";
import {
  oauthDeviceAuthorization,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { DBFieldAttribute } from "better-auth/db";
import { jwt } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { ApiConfig, Config } from "../../config.js";
import type { AppDeps, SignInProvider } from "../../context.js";
import * as authTables from "../../db/schema/auth.js";
import { isMockHost } from "../../http/fetcher.js";
import { followSetupSignIn, setupSignInOf } from "../setup/link.js";
import { PASSWORD_PATHS } from "./password-paths.js";
import { inviteLookupEndpoint, passwordEndpoints } from "./invites.js";
import { revokeGrantsOf } from "./grants.js";
import { sendPasswordLink } from "./email.js";
import { clientAddress } from "./client-address.js";
import { devSignIn, devSignInOpen } from "./dev-sign-in.js";
import {
  DEVICE_ANSWER_RULE,
  DEVICE_CODE_RULE,
  devicePlugin,
  guardDevice,
  registerCliClient,
} from "./device.js";
import { guardOAuth, oauthPlugins } from "./oauth.js";
import {
  admitAtSignIn,
  admitSession,
  microsoftEmail,
  type Expected,
  sessionEnd,
  signingIn,
} from "./sign-in.js";

/**
 * What a person reaches before they have a session: starting a sign-in, a
 * provider's callback, a passkey sign-in and the dev sign-in. public-paths.ts
 * lists the same paths.
 */
export const PUBLIC_AUTH_ROUTES = [
  ...PASSWORD_PATHS.filter((path) => path !== "/change-password").map(
    (path) => ({ path: `/api/auth${path}`, method: "POST" as const }),
  ),
  { path: "/api/auth/invites/lookup", method: "POST" },
  { path: "/api/auth/sign-in/social", method: "POST" },
  { path: "/api/auth/callback/microsoft", method: "GET" },
  { path: "/api/auth/callback/google", method: "GET" },
  { path: "/api/auth/sign-in/sso", method: "POST" },
  { path: "/api/auth/sso/callback", method: "GET" },
  { path: "/api/auth/passkey/generate-authenticate-options", method: "GET" },
  { path: "/api/auth/passkey/verify-authentication", method: "POST" },
  { path: "/api/auth/dev/sign-in", method: "POST" },
  // OAuth (oauth.ts, device.ts): authorizing sends a person with no session
  // to sign in; clients reach the others with no session at all.
  { path: "/api/auth/oauth2/authorize", method: "GET" },
  { path: "/api/auth/oauth2/token", method: "POST" },
  { path: "/api/auth/oauth2/register", method: "POST" },
  { path: "/api/auth/device/code", method: "POST" },
] as const;

/** What a signed-in person reaches. app.ts routes these and the public ones to Better Auth, and nothing else. */
export const SESSION_AUTH_ROUTES = [
  { path: "/api/auth/change-password", method: "POST" },
  { path: "/api/auth/sign-out", method: "POST" },
  // Ends the person's other browser sessions; their MCP and CLI grants stay.
  { path: "/api/auth/revoke-other-sessions", method: "POST" },
  { path: "/api/auth/get-session", method: "GET" },
  { path: "/api/auth/passkey/generate-register-options", method: "GET" },
  { path: "/api/auth/passkey/verify-registration", method: "POST" },
  { path: "/api/auth/passkey/list-user-passkeys", method: "GET" },
  { path: "/api/auth/passkey/delete-passkey", method: "POST" },
] as const;

/** The person a session cookie names, as the authenticate middleware reads it. */
export type SignedIn = {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: { id: string; sign_in_method: string };
};

export type Auth = {
  /** Answers a request under /api/auth; `peer` is the connection's address. */
  handle(request: Request, peer: string | null): Promise<Response>;
  /** The person the request's session cookie names, or null. */
  session(headers: Headers): Promise<SignedIn | null>;
  /** RFC 8414 metadata for the OAuth provider, as Better Auth builds it. */
  authorizationServer(): Promise<Record<string, unknown>>;
  /** The setup saved what sign-in is built from: read it again at the next request, so its "Sign in now" works at once. */
  reread(): void;
};

/** A session ends this long after sign-in, however busy it is; a passkey's may end sooner (sessionEnd). */
const SESSION_SECONDS = 7 * 24 * 60 * 60;

const sessionFields = {
  sign_in_method: { type: "string", required: true, input: false },
} satisfies Record<string, DBFieldAttribute>;

/** What Better Auth's CLI needs to write src/db/schema/auth.ts (schema-config.ts). */
export const SCHEMA_OPTIONS = {
  session: { additionalFields: sessionFields },
  rateLimit: { storage: "database" },
  plugins: [
    sso(),
    passkey(),
    jwt(),
    oauthProvider({ loginPage: "/sign-in", consentPage: "/oauth/consent" }),
    oauthDeviceAuthorization(),
  ],
} satisfies Partial<BetterAuthOptions>;

/** How long what createAuth read from settings and secrets serves before it reads them again. */
const READ_FOR_MS = 30_000;
/** How long a build that left out a provider (its discovery failed) serves before trying again. */
const RETRY_AFTER_MS = 60_000;

const PASSKEY_UNVERIFIED =
  "A passkey works here only when your device checks it is you, with a PIN, a fingerprint or your face.";

/**
 * Better Auth's passkey plugin verifies assertions without requiring user
 * verification, so its hooks refuse a passkey whose device did not verify
 * the person, at registration and at every sign-in.
 */
function requireUserVerified(userVerified: boolean): void {
  if (!userVerified)
    throw new APIError("FORBIDDEN", {
      code: "user_not_verified",
      message: PASSKEY_UNVERIFIED,
    });
}

/** Starting a sign-in only redirects to the provider, so a busy office needs more than Better Auth's 3 in 10 seconds. */
const SIGN_IN_START_RULE = { window: 60, max: 60 };

type AuthInputs = {
  tenant_id: string | null;
  app_client_id: string | null;
  authority: string;
  app_client_secret: string | null;
  providers: (SignInProvider & { client_secret: string | null })[];
  passkeys: boolean;
  email_password: boolean;
};

type Instance = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<SignedIn | null>;
    getOAuthServerConfig(): Promise<object>;
  };
};

/**
 * Better Auth on the api's database. It is configured at construction, so
 * the instance serves until a digest of the settings and secrets it was
 * built from changes; those are read again at most every READ_FOR_MS.
 */
export function createAuth(deps: AppDeps): Auth {
  let built: {
    key: string;
    instance: Instance;
    incomplete: boolean;
    valid_until: number;
  } | null = null;

  async function current(): Promise<Instance> {
    const now = deps.clock().getTime();
    if (built !== null && now < built.valid_until) return built.instance;
    const inputs = await readInputs(deps);
    const key = createHash("sha256")
      .update(JSON.stringify(inputs))
      .digest("hex");
    if (built?.key === key && !built.incomplete) {
      built.valid_until = now + READ_FOR_MS;
      return built.instance;
    }
    const { instance, incomplete } = await buildAuth(deps, inputs);
    const valid_until = now + (incomplete ? RETRY_AFTER_MS : READ_FOR_MS);
    built = { key, instance, incomplete, valid_until };
    return instance;
  }

  return {
    handle: async (request, peer) => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname).replace(
          /\/+$/,
          "",
        );
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        return new Response(null, { status: 404 });
      }
      if (
        PASSWORD_PATHS.some((path) => pathname === `/api/auth${path}`) &&
        !(await deps.settings.get("sign_in.email_password"))
      )
        return Response.json(
          { message: "Email and password sign-in is off." },
          { status: 403 },
        );
      const config = apiConfig(deps.config);
      const client = clientAddress(peer, request.headers, config);
      const setup_sign_in = setupSignInOf(request);
      const forward = async (guarded: Request) =>
        signingIn.run({ claims: null, setup_sign_in }, async () =>
          (await current()).handler(withClient(guarded, client)),
        );
      const response = await guardOAuth(deps, request, (guarded) =>
        guardDevice(deps, guarded, client, forward),
      );
      return withoutSessionToken(
        await followSetupSignIn(deps, setup_sign_in, response),
      );
    },
    // Reading a session needs no provider, so the last instance built serves.
    session: async (headers) =>
      (built?.instance ?? (await current())).api.getSession({ headers }),
    authorizationServer: async () => ({
      ...(await (await current()).api.getOAuthServerConfig()),
    }),
    reread: () => {
      if (built !== null) built.valid_until = 0;
    },
  };
}

export function apiConfig(config: Config): ApiConfig {
  if (config.container !== "api")
    throw new Error("Better Auth runs in the api only.");
  return config;
}

function inDevelopmentOrTest(config: Config): boolean {
  return config.node_env === "development" || config.node_env === "test";
}

export async function readInputs(deps: AppDeps): Promise<AuthInputs> {
  const { settings, secrets } = deps;
  const [
    tenant_id,
    app_client_id,
    authority,
    providers,
    passkeys,
    app_client_secret,
  ] = await Promise.all([
    settings.get("powerbi.tenant_id"),
    settings.get("powerbi.app_client_id"),
    settings.get("powerbi.authority"),
    settings.get("sign_in.providers"),
    settings.get("sign_in.passkeys"),
    secrets.read("powerbi_app_client_secret"),
  ]);
  return {
    tenant_id,
    app_client_id,
    authority,
    app_client_secret,
    passkeys,
    email_password: await settings.get("sign_in.email_password"),
    providers: await Promise.all(
      providers.map(async (provider) => ({
        ...provider,
        client_secret: await secrets.read(
          `sign_in_${provider.id}_client_secret`,
        ),
      })),
    ),
  };
}

/** The public base URL, and in development and test also each OpenID Connect issuer, which may then be the mock on loopback. */
export function trustedOriginsFor(
  config: Config,
  providers: readonly SignInProvider[],
): string[] {
  const issuers = inDevelopmentOrTest(config)
    ? providers.flatMap((p) =>
        p.kind === "oidc" && p.issuer ? [new URL(p.issuer).origin] : [],
      )
    : [];
  return [config.public_base_url.origin, ...issuers];
}

export async function buildAuth(deps: AppDeps, inputs: AuthInputs) {
  const config = apiConfig(deps.config);
  const authority = new URL(inputs.authority);
  // The demo's authority is the mock, reached over http as the fetcher reaches it.
  if (
    !inDevelopmentOrTest(config) &&
    authority.protocol !== "https:" &&
    !(config.demo_mode && isMockHost(authority.hostname))
  )
    throw new Error(
      "powerbi.authority must be an https URL outside development and test.",
    );
  const base = config.public_base_url.href.replace(/\/$/, "");
  const ready = inputs.providers.filter((p) => p.client_secret !== null);
  const oidc = await Promise.all(
    ready
      .filter((p) => p.kind === "oidc")
      .map((p) => discover(deps, p, inDevelopmentOrTest(config))),
  );
  const google = ready.find((p) => p.kind === "google");
  const expected: Expected = {
    tenant_id: inputs.tenant_id,
    app_client_id: inputs.app_client_id,
    authority: inputs.authority,
    google_id: google?.id ?? null,
  };
  const microsoft =
    inputs.tenant_id !== null &&
    inputs.app_client_id !== null &&
    inputs.app_client_secret !== null
      ? {
          clientId: inputs.app_client_id,
          clientSecret: inputs.app_client_secret,
          tenantId: inputs.tenant_id,
          authority: inputs.authority,
          // Sign-in asks for nothing that reaches Power BI or Graph; the connection does.
          authorizationEndpoint: `${inputs.authority.replace(/\/+$/, "")}/${inputs.tenant_id}/oauth2/v2.0/authorize?${new URLSearchParams(
            {
              claims: JSON.stringify({ id_token: { xms_edov: null } }),
            },
          ).toString()}`,
          disableDefaultScope: true,
          scope: ["openid", "profile", "email"],
          disableProfilePhoto: true,
          // Only the code flow: an ID token a browser posts is never taken.
          disableIdTokenSignIn: true,
          // An email counts as verified only when the tenant's own directory vouches for it.
          mapProfileToUser: (profile: {
            tid: string;
            [claim: string]: unknown;
          }) => {
            const email = microsoftEmail(profile);
            return {
              email,
              emailVerified:
                email !== undefined && profile.tid === inputs.tenant_id,
            };
          },
        }
      : null;

  const instance = betterAuth({
    appName: "Power BI Metrics Book",
    baseURL: base,
    basePath: "/api/auth",
    secret: config.auth_secret,
    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: authTables,
    }),
    telemetry: { enabled: false },
    // Better Auth's own lines carry only their level and message, never the values it adds.
    logger: {
      log: (level, message) => {
        deps.logger[level](message);
      },
    },
    trustedOrigins: trustedOriginsFor(config, inputs.providers),
    emailAndPassword: {
      enabled: inputs.email_password,
      disableSignUp: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        await revokeGrantsOf(deps.db, user.id);
        await deps.db
          .update(authTables.user)
          .set({ emailVerified: true })
          .where(eq(authTables.user.id, user.id));
      },
      sendResetPassword: ({ user, token }) =>
        sendPasswordLink(deps, user.email, token),
    },
    verification: { storeIdentifier: "hashed" },
    socialProviders: {
      ...(microsoft === null ? {} : { microsoft }),
      ...(google?.client_secret == null
        ? {}
        : {
            google: {
              clientId: google.client_id,
              clientSecret: google.client_secret,
              disableIdTokenSignIn: true,
            },
          }),
    },
    // A second provider's sign-in never joins an account another made.
    account: {
      updateAccountOnSignIn: false,
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    user: { validateUserInfo: (data) => admitAtSignIn(deps, expected, data) },
    session: {
      expiresIn: SESSION_SECONDS,
      disableSessionRefresh: true,
      additionalFields: sessionFields,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/invites/accept": { window: 10, max: 3 },
        "/email/forgot-password": { window: 60, max: 3 },
        "/reset-password": { window: 10, max: 3 },
        "/sign-in/social": SIGN_IN_START_RULE,
        "/sign-in/sso": SIGN_IN_START_RULE,
        "/device/code": DEVICE_CODE_RULE,
        "/device/approve": DEVICE_ANSWER_RULE,
        "/device/deny": DEVICE_ANSWER_RULE,
      },
    },
    databaseHooks: {
      account: ACCOUNT_HOOKS,
      session: {
        create: {
          before: async (session, context) => {
            const sign_in_method = await admitSession(
              deps,
              session.userId,
              context?.path ?? null,
            );
            // Better Auth's getSession refuses a row past expiresAt, so a
            // passkey's earlier end holds though its cookie says 7 days.
            const expiresAt = await sessionEnd(
              deps.db,
              session.userId,
              sign_in_method,
              session.expiresAt,
            );
            return { data: { ...session, sign_in_method, expiresAt } };
          },
        },
      },
    },
    advanced: {
      useSecureCookies: true,
      // handle() sets this header to the one address it trusts.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    // A refused sign-in lands on the SPA's sign-in page, which shows
    // error_description. An error that is not Better Auth's own answer is
    // thrown on to app.ts's onError, which logs it without a query's
    // parameters, rather than printed whole by Better Auth's router.
    onAPIError: { errorURL: `${base}/sign-in`, throw: true },
    plugins: [
      inviteLookupEndpoint(deps),
      ...(inputs.email_password ? [passwordEndpoints(deps)] : []),
      sso({
        defaultSSO: oidc.flatMap((entry) =>
          entry === null
            ? []
            : [
                {
                  domain: "",
                  providerId: entry.providerId,
                  oidcConfig: entry.oidcConfig,
                },
              ],
        ),
        // Providers come from settings only; nobody registers one through Better Auth.
        providersLimit: 0,
        redirectURI: "/sso/callback",
        // A provider's email_verified counts; without it every email is unverified.
        trustEmailVerified: true,
      }),
      ...(inputs.passkeys
        ? [
            passkey({
              rpID: config.public_base_url.hostname,
              rpName: "Power BI Metrics Book",
              origin: config.public_base_url.origin,
              authenticatorSelection: {
                residentKey: "preferred",
                userVerification: "required",
              },
              registration: {
                afterVerification: ({ verification }) => {
                  requireUserVerified(
                    verification.registrationInfo?.userVerified === true,
                  );
                },
              },
              authentication: {
                afterVerification: ({ verification }) => {
                  requireUserVerified(
                    verification.authenticationInfo.userVerified,
                  );
                },
              },
            }),
          ]
        : []),
      ...(devSignInOpen(config) ? [devSignIn()] : []),
      ...oauthPlugins(deps),
      devicePlugin(deps),
    ],
  });
  // Initialising Better Auth seeds the OAuth resources the CLI's client is linked to.
  await instance.$context;
  await registerCliClient(deps.db, config.public_base_url);
  return { instance, incomplete: oidc.includes(null) };
}

function withoutTokens<T extends object>(account: T) {
  return Promise.resolve({
    data: {
      ...account,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  });
}

/** Sign-in needs no provider token after the callback, so none is ever stored. */
const ACCOUNT_HOOKS = {
  create: { before: withoutTokens },
  update: { before: withoutTokens },
};

/** The request as Better Auth sees it: X-Forwarded-For names only the client address handle() settled on, whichever header it came from. */
function withClient(request: Request, client: string | null): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-for");
  if (client !== null) headers.set("x-forwarded-for", client);
  return new Request(request, { headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The session token is the cookie's value; no JSON answer repeats it. */
async function withoutSessionToken(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json"))
    return response;
  // A redirect says it is JSON and carries no body.
  const text = await response.clone().text();
  if (text === "") return response;
  const body: unknown = JSON.parse(text);
  if (!isRecord(body)) return response;
  const cleaned: Record<string, unknown> = { ...body };
  delete cleaned.token;
  if (isRecord(cleaned.session)) {
    const session = { ...cleaned.session };
    delete session.token;
    cleaned.session = session;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(cleaned), {
    status: response.status,
    headers,
  });
}

/**
 * An OpenID Connect provider's endpoints from its discovery document,
 * fetched through the guarded fetcher's profile for URLs an admin typed in.
 * A provider whose discovery fails is left out of this build and logged.
 */
async function discover(
  deps: AppDeps,
  provider: SignInProvider & { client_secret: string | null },
  developmentOrTest: boolean,
): Promise<{ providerId: string; oidcConfig: OIDCConfig } | null> {
  const issuer = provider.issuer;
  if (issuer === null)
    throw new Error(
      `sign_in.providers: the OpenID Connect provider ${provider.id} has no issuer.`,
    );
  const discoveryEndpoint = computeDiscoveryUrl(issuer);
  try {
    const response = await deps.fetcher.fetchUntrusted(discoveryEndpoint, {
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(
        `the discovery document answered ${String(response.status)}`,
      );
    const document = (await response.json()) as OIDCDiscoveryDocument;
    validateDiscoveryDocument(document, issuer);
    const endpoints = issuerEndpoints(document, issuer, developmentOrTest);
    return {
      providerId: provider.id,
      oidcConfig: {
        issuer,
        pkce: true,
        clientId: provider.client_id,
        clientSecret: provider.client_secret ?? undefined,
        discoveryEndpoint,
        ...endpoints,
        tokenEndpointAuthentication: selectTokenEndpointAuthMethod(document),
        scopes: ["openid", "profile", "email"],
      },
    };
  } catch (error) {
    deps.logger.warn("a sign-in provider's discovery failed", {
      provider: provider.id,
      error: String(error),
    });
    return null;
  }
}

/**
 * The endpoints sign-in uses, each required on the issuer's own origin and,
 * outside development and test, over https. A userinfo endpoint elsewhere
 * (Entra names Graph's) is left out, and the ID token's claims serve.
 */
export function issuerEndpoints(
  document: OIDCDiscoveryDocument,
  issuer: string,
  developmentOrTest: boolean,
): Pick<
  OIDCConfig,
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "jwksEndpoint"
  | "userInfoEndpoint"
> {
  const origin = new URL(issuer).origin;
  const onIssuer = (url: string | undefined) =>
    url !== undefined &&
    URL.canParse(url) &&
    new URL(url).origin === origin &&
    (developmentOrTest || new URL(url).protocol === "https:");
  const required = {
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
    jwksEndpoint: document.jwks_uri,
  };
  for (const [name, url] of Object.entries(required))
    if (!onIssuer(url))
      throw new Error(
        `the discovery document's ${name} is not on the issuer's origin ${origin} over https`,
      );
  const userinfo = document.userinfo_endpoint;
  return {
    ...required,
    userInfoEndpoint: onIssuer(userinfo) ? userinfo : undefined,
  };
}
