import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import {
  createMockPowerBi,
  type MockPowerBiHandle,
  type Person,
  sampleTenant,
  startMockPowerBi,
  type Tenant,
} from "@powerbi-metrics-book/powerbi-mock";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { request } from "undici";
import { expect } from "vitest";
import { type AppEnv, createApp } from "../src/app.js";
import type { AppDeps, SignInProvider } from "../src/context.js";
import { user } from "../src/db/schema/auth.js";
import { createGuardedFetcher } from "../src/http/fetcher.js";
import { assignRole } from "../src/services/auth/roles.js";
import { createVault } from "../src/services/connection/vault.js";
import type { LoadedIdentity } from "../src/services/secrets/identities.js";
import {
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "./deps.js";
import { MemorySecrets, MemorySettings } from "./doubles.js";
import { newIdentity } from "./secrets-support.js";

/*
 * Sign-in through the mock's Microsoft identity routes and its second OpenID
 * Connect provider, as a browser does it. Each fixture gives the sample
 * tenant's people and groups ids and emails of its own, since every test file
 * shares one database, and each request a connection address of its own, so
 * the rate limits of one test never reach another.
 */

const OIDC_SECRET = "sample-oidc-secret";

/** The second provider, and one whose userinfo calls every email unverified. */
export const OIDC = "sample_oidc";
export const UNVERIFIED_OIDC = "unverified_oidc";

export type SignInFixture = {
  app: Hono<AppEnv>;
  deps: AppDeps;
  settings: MemorySettings;
  tenant: Tenant;
  /** What deps.logger was given, one line per call. */
  logged: { level: string; message: string; fields: unknown }[];
  /** Moves deps.clock on, past createAuth's 30 seconds of reading settings once. */
  advance(ms: number): void;
  person(mailbox: string): Person;
  group(name: string): string;
  /** The Better Auth user id a sign-in made for this email. */
  userId(email: string): Promise<string>;
  /** Makes the main mock sign this person in at its next authorize. */
  actAs(who: Person): void;
  /** The main mock answers status once to the next request under route_prefix. */
  failNext(route_prefix: string, status: number): void;
  /** A request from a connection address no other request used. */
  request(path: string, init?: RequestInit, peer?: string): Promise<Response>;
  /** callbackURL is where Better Auth sends the browser after the callback: `/` unless a test chains on. */
  signIn(
    who: Person,
    provider: string,
    callbackURL?: string,
    options?: { scopes?: string[] },
  ): Promise<{ callback: Response; cookie: string }>;
  close(): Promise<void>;
};

let peers = 0;

/**
 * An address in 198.18.0.0/15, the range kept for tests, that this file has
 * not used yet. Rate limits count per address, so each request a test makes
 * from a fresh peer starts its own count.
 */
export function freshPeer(): string {
  peers += 1;
  const n = peers;
  return `198.${String(18 + (n >> 16))}.${String((n >> 8) & 255)}.${String(n & 255)}`;
}

/** The cookies the responses set, the later winning, as a Cookie header. */
export function cookies(...responses: Response[]): string {
  const jar = new Map<string, string>();
  for (const cookie of responses.flatMap((r) => r.headers.getSetCookie())) {
    const [pair = ""] = cookie.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar]
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function ownTenant(run: string): Tenant {
  const own = sampleTenant({ public_base_url: TEST_PUBLIC_BASE_URL });
  const groupIds = new Map(own.groups.map((g) => [g.object_id, randomUUID()]));
  const renamed = (id: string) => groupIds.get(id) ?? id;
  own.groups = own.groups.map((g) => ({
    ...g,
    object_id: renamed(g.object_id),
  }));
  own.people = own.people.map((p) => ({
    ...p,
    object_id: randomUUID(),
    email: p.email.replace("@", `+${run}@`),
    user_principal_name: p.user_principal_name.replace("@", `+${run}@`),
    group_ids: p.group_ids.map(renamed),
  }));
  own.apps_registrations.push({
    client_id: `sample-oidc-${run}`,
    secret: OIDC_SECRET,
    redirect_uris: [`${TEST_PUBLIC_BASE_URL}/api/auth/sso/callback`],
    kind: "confidential_web",
  });
  return own;
}

/** A second mock of the same tenant whose OpenID Connect userinfo says email_verified: false. */
async function startUnverifiedOidc(tenant: Tenant): Promise<
  Pick<MockPowerBiHandle, "url" | "close"> & {
    actAs(object_id: string): Promise<void>;
  }
> {
  const inner = createMockPowerBi({ tenant, control: true });
  const outer = new Hono();
  outer.get("/oidc/userinfo", async (c) => {
    const answer = await inner.fetch(c.req.raw);
    if (!answer.ok) return answer;
    const claims = (await answer.json()) as Record<string, unknown>;
    return c.json({ ...claims, email_verified: false });
  });
  outer.all("*", (c) => inner.fetch(c.req.raw));
  const listener = getRequestListener(outer.fetch);
  const server = createServer(
    (incoming, outgoing) => void listener(incoming, outgoing),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the unverified provider did not bind a port");
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
    actAs: async (object_id) => {
      const answer = await inner.request("/_mock/acting-user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ object_id }),
      });
      expect(answer.status).toBe(204);
    },
  };
}

/** A vault for options.identity, or for a fresh one. */
export async function startSignIn(
  options: { env?: Record<string, string>; identity?: LoadedIdentity } = {},
): Promise<SignInFixture> {
  const run = randomUUID().slice(0, 8);
  const tenant = ownTenant(run);
  const mock = await startMockPowerBi({ tenant, control: true });
  const unverified = await startUnverifiedOidc(tenant);
  const toMocks = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([mock.url, unverified.url]),
    nodeEnv: "test",
  });
  const oidc = (id: string, url: string): SignInProvider => ({
    id,
    kind: "oidc",
    label: id,
    client_id: `sample-oidc-${run}`,
    issuer: `${url}/oidc`,
  });
  const settings = new MemorySettings({
    "powerbi.tenant_id": tenant.tenant_id,
    "powerbi.app_client_id": tenant.apps_registrations[0]?.client_id ?? null,
    "powerbi.authority": mock.url,
    "powerbi.graph_url": `${mock.url}/graph`,
    "sign_in.providers": [
      oidc(OIDC, mock.url),
      oidc(UNVERIFIED_OIDC, unverified.url),
    ],
  });
  const config = testConfig("api", options.env ?? {});
  const logged: SignInFixture["logged"] = [];
  const log =
    (level: string) =>
    (message: string, fields?: unknown): void =>
      void logged.push({ level, message, fields });
  let offset = 0;
  const deps = createTestDeps({
    config,
    vault: createVault(config, options.identity ?? (await newIdentity())),
    clock: () => new Date(Date.now() + offset),
    settings,
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", "sample-app-secret"],
      [`sign_in_${OIDC}_client_secret`, OIDC_SECRET],
      [`sign_in_${UNVERIFIED_OIDC}_client_secret`, OIDC_SECRET],
    ]),
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    // The mocks are on loopback over http, which fetchUntrusted refuses;
    // here an issuer's discovery reaches them through the fixed-host profile.
    fetcher: {
      fetchFixed: (url, init) => toMocks.fetchFixed(url, init),
      // fetchFixed takes its own redirect choice, not RequestInit's; neither follows one.
      fetchUntrusted: (url, init = {}) =>
        toMocks.fetchFixed(url, { ...init, redirect: "refuse" }),
    },
  });
  const app = createApp(deps);
  const find = <T>(items: T[], found: (item: T) => boolean, what: string) => {
    const item = items.find(found);
    if (item === undefined) throw new Error(`no ${what} in the sample tenant`);
    return item;
  };
  const fromPeer = async (
    path: string,
    init: RequestInit = {},
    peer = freshPeer(),
  ) =>
    app.request(path, init, { incoming: { socket: { remoteAddress: peer } } });

  return {
    app,
    deps,
    settings,
    tenant,
    logged,
    advance: (ms) => {
      offset += ms;
    },
    person: (mailbox) =>
      find(tenant.people, (p) => p.email.startsWith(`${mailbox}+`), mailbox),
    group: (name) =>
      find(tenant.groups, (g) => g.name === name, name).object_id,
    async userId(email) {
      const [row] = await deps.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email));
      if (row === undefined) throw new Error(`${email} has not signed in`);
      return row.id;
    },
    actAs: (who) => {
      mock.setActingUser(who.object_id);
    },
    failNext: (route_prefix, status) => {
      mock.failNext(route_prefix, status);
    },
    request: fromPeer,
    async signIn(who, provider, callbackURL = "/", options = {}) {
      if (provider === UNVERIFIED_OIDC) await unverified.actAs(who.object_id);
      else mock.setActingUser(who.object_id);
      const [path, body] =
        provider === "microsoft"
          ? ["/api/auth/sign-in/social", { provider }]
          : ["/api/auth/sign-in/sso", { providerId: provider }];
      const started = await fromPeer(path, {
        method: "POST",
        headers: {
          origin: TEST_PUBLIC_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callbackURL, ...body }),
      });
      expect(started.status).toBe(200);
      const { url } = (await started.json()) as { url: string };
      const authorize = new URL(url);
      if (options.scopes !== undefined)
        authorize.searchParams.set("scope", options.scopes.join(" "));
      const authorized = await request(authorize);
      await authorized.body.dump();
      expect(authorized.statusCode).toBe(302);
      const back = new URL(String(authorized.headers.location));
      const callback = await fromPeer(`${back.pathname}${back.search}`, {
        headers: { cookie: cookies(started) },
      });
      return { callback, cookie: cookies(started, callback) };
    },
    close: async () => {
      await Promise.all([mock.close(), unverified.close()]);
    },
  };
}

/*
 * OAuth as an MCP client or the CLI does it, end to end against the app, with
 * the dev sign-in for the person. A client's metadata document is served
 * through fetchUntrusted; any other URL resolves to a private address, so the
 * guarded fetcher's real refusal answers. The connector's whoami names the
 * principal a token on /api/mcp yields; /api/v1/test/principal names the one
 * on /api/v1.
 */

export type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
};

export type OAuthFixture = {
  /** A request to the app from a connection address no other request used. */
  request(path: string, init?: RequestInit): Promise<Response>;
  deps: AppDeps;
  /** A person holding viewer, signed in through the dev sign-in. */
  person(): Promise<{ id: string; email: string; cookie: string }>;
  /** A new MCP client, its metadata document served at its client_id. */
  client(): { client_id: string; redirect_uri: string };
  /** GET /api/auth/oauth2/authorize as the person, with this whole query. */
  authorize(cookie: string, query: Record<string, string>): Promise<Response>;
  /** POST the SPA's Allow or Deny for the consent screen `authorize` led to. */
  consent(cookie: string, authorized: Response, allow: boolean): Promise<URL>;
  /** The authorization code flow up to the tokens, pressing Allow; `query` adds to the authorization. */
  connect(
    cookie: string,
    client: { client_id: string; redirect_uri: string },
    query?: Record<string, string>,
  ): Promise<Tokens>;
  /** `pbmb login`: the device flow, the person pressing Allow on /device. */
  login(cookie: string): Promise<Tokens>;
  /** Its steps: POST /device/code as the CLI (`fields` change its form), the SPA's look and answer, a poll. */
  startLogin(fields?: Record<string, string>): Promise<Response>;
  showCode(cookie: string, user_code: string): Promise<Response>;
  answerCode(
    cookie: string,
    user_code: string,
    allow: boolean,
  ): Promise<Response>;
  poll(device_code: string): Promise<Response>;
  /** POST /api/auth/oauth2/token, form-encoded and with no Origin, as a client sends it. */
  token(form: Record<string, string>): Promise<Response>;
  /** A request carrying the access token. */
  bearer(path: string, token: string): Promise<Response>;
  /** The connector's whoami, called with the access token as an MCP client calls it. */
  whoami(token: string): Promise<Response>;
};

/** A JSON POST from the SPA, signed in. */
export function fromSpa(cookie: string, body: object): RequestInit {
  return {
    method: "POST",
    headers: {
      cookie,
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function startOAuth(overrides: Partial<AppDeps> = {}): OAuthFixture {
  const run = randomUUID().slice(0, 8);
  const documents = new Map<string, Record<string, unknown>>();
  const privateNetwork = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([]),
    nodeEnv: "test",
    lookup: () => Promise.resolve([{ address: "10.20.30.40", family: 4 }]),
  });
  const deps = createTestDeps({
    config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1" }),
    fetcher: {
      fetchFixed: (url, init) => privateNetwork.fetchFixed(url, init),
      fetchUntrusted: (url, init) => {
        const document = documents.get(String(url));
        return document === undefined
          ? privateNetwork.fetchUntrusted(url, init)
          : Promise.resolve(Response.json(document));
      },
    },
    ...overrides,
  });
  const app = createApp(deps);
  app.get("/api/v1/test/principal", (c) => c.json(c.get("principal") ?? null));
  const request = async (path: string, init?: RequestInit) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: freshPeer() } },
    });
  let people = 0;
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const authorize = async (cookie: string, query: Record<string, string>) =>
    request(
      `/api/auth/oauth2/authorize?${new URLSearchParams(query).toString()}`,
      { headers: { cookie } },
    );
  const consent = async (
    cookie: string,
    authorized: Response,
    allow: boolean,
  ) => {
    expect(authorized.status).toBe(302);
    const page = new URL(
      authorized.headers.get("location") ?? "",
      TEST_PUBLIC_BASE_URL,
    );
    expect(page.pathname).toBe("/oauth/consent");
    const answer = await request(
      "/api/v1/oauth/consent",
      fromSpa(cookie, { request: page.search.slice(1), allow }),
    );
    expect(answer.status, await answer.clone().text()).toBe(200);
    return new URL(
      ((await answer.json()) as { redirect_to: string }).redirect_to,
    );
  };
  const token = async (fields: Record<string, string>) =>
    request("/api/auth/oauth2/token", form(fields));
  const startLogin = async (fields: Record<string, string> = {}) =>
    request(
      "/api/auth/device/code",
      form({
        client_id: "pbmb-cli",
        scope: "api offline_access",
        resource: `${TEST_PUBLIC_BASE_URL}/api/v1`,
        ...fields,
      }),
    );
  const answerCode = async (
    cookie: string,
    user_code: string,
    allow: boolean,
  ) => request("/api/v1/oauth/device", fromSpa(cookie, { user_code, allow }));
  const poll = async (device_code: string) =>
    token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code,
      client_id: "pbmb-cli",
    });
  return {
    request,
    deps,
    person: async () => {
      people += 1;
      const email = `oauth-${run}-${String(people)}@example.test`;
      await assignRole(
        deps.db,
        { role: "viewer", subject_kind: "person", subject: email },
        principals.admin,
      );
      const signedIn = await request(
        "/api/auth/dev/sign-in",
        fromSpa("", { email }),
      );
      expect(signedIn.status).toBe(200);
      const { user_id } = (await signedIn.json()) as { user_id: string };
      return { id: user_id, email, cookie: cookies(signedIn) };
    },
    client: () => {
      const client_id = `https://client.example.org/${randomUUID()}/client.json`;
      const redirect_uri = "https://client.example.org/callback";
      documents.set(client_id, {
        client_id,
        client_name: "MCP client",
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
      });
      return { client_id, redirect_uri };
    },
    authorize,
    consent,
    connect: async (cookie, client, query = {}) => {
      const { verifier, challenge } = pkce();
      const authorized = await authorize(cookie, {
        response_type: "code",
        ...client,
        state: "sample-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${TEST_PUBLIC_BASE_URL}/api/mcp`,
        ...query,
      });
      const back = await consent(cookie, authorized, true);
      const answer = await token({
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        redirect_uri: client.redirect_uri,
        client_id: client.client_id,
        code_verifier: verifier,
      });
      expect(answer.status, await answer.clone().text()).toBe(200);
      return (await answer.json()) as Tokens;
    },
    login: async (cookie) => {
      const started = await startLogin();
      expect(started.status, await started.clone().text()).toBe(200);
      const { device_code, user_code } = (await started.json()) as {
        device_code: string;
        user_code: string;
      };
      const allowed = await answerCode(cookie, user_code, true);
      expect(allowed.status, await allowed.clone().text()).toBe(204);
      const answer = await poll(device_code);
      expect(answer.status, await answer.clone().text()).toBe(200);
      return (await answer.json()) as Tokens;
    },
    startLogin,
    showCode: async (cookie, user_code) =>
      request(`/api/v1/oauth/device?user_code=${user_code}`, {
        headers: { cookie },
      }),
    answerCode,
    poll,
    token,
    bearer: async (path, accessToken) =>
      request(path, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    whoami: async (accessToken) =>
      request("/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      }),
  };
}

/** What a tools/call answered, parsed from its one text block. */
export async function toolAnswer(response: Response): Promise<unknown> {
  const { result } = (await response.json()) as {
    result: { content: [{ text: string }] };
  };
  return JSON.parse(result.content[0].text);
}

/**
 * Power BI's connection round trip as a browser makes it: the api's path
 * (connect, or where sign-in sent the browser), the mock's authorize, then
 * the api's callback, whose answer and URL come back. A connect that
 * answers anything but a redirect is answered as it is.
 */
export async function followConnect(
  app: Hono<AppEnv>,
  cookie: string,
  path = "/api/v1/powerbi/connect",
): Promise<{ answer: Response; callback_url: string | null }> {
  const started = await app.request(path, { headers: { cookie } });
  const location = started.headers.get("location");
  if (started.status !== 302 || location === null)
    return { answer: started, callback_url: null };
  const authorized = await request(location);
  await authorized.body.dump();
  expect(authorized.statusCode).toBe(302);
  const back = new URL(String(authorized.headers.location));
  const callback_url = `${back.pathname}${back.search}`;
  const answer = await app.request(callback_url, { headers: { cookie } });
  return { answer, callback_url };
}
