import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sampleTenant,
  startMockPowerBi,
  type MockPowerBiHandle,
  type Person,
  type Tenant,
} from "@powerbi-metrics-book/powerbi-mock";
import type { Hono } from "hono";
import { request } from "undici";
import { expect } from "vitest";
import { type AppEnv, createApp } from "../src/app.js";
import type { AppDeps, Container } from "../src/context.js";
import { createGuardedFetcher } from "../src/http/fetcher.js";
import { createVault } from "../src/services/connection/vault.js";
import { runJobs } from "../src/services/jobs/runner.js";
import { createSecretReader } from "../src/services/secrets/store.js";
import { createSettingsStore } from "../src/services/settings/store.js";
import { newSetupLink } from "../src/services/setup/link.js";
import {
  cerbosAccess,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "./deps.js";
import { publishedIdentities } from "./secrets-support.js";
import { cookies, freshPeer } from "./sign-in-support.js";
import "../src/services/jobs/all.js";

/*
 * The setup's tests: an empty database, the sample tenant in the mock, and
 * the api and the worker each with its real settings store, its own identity
 * and the secrets encrypted to it, as a deployment starts.
 */

export type SetupFixture = {
  app: Hono<AppEnv>;
  api: AppDeps;
  worker: AppDeps;
  mock: MockPowerBiHandle;
  /** The mock reads it on every request, so a test may change its settings. */
  tenant: Tenant;
  person(mailbox: string): Person;
  /** From a connection address no other request used. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON POST from this site. */
  post(
    path: string,
    cookie: string,
    body?: object,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** A link from newSetupLink, used: the setup session's cookie. */
  openSession(): Promise<string>;
  /** The Microsoft sign-in as a browser holding cookie makes it; answers the cookies after the callback. */
  signIn(
    who: Person,
    cookie: string,
  ): Promise<{ callback: Response; cookie: string }>;
  /** Its start alone: Microsoft's authorize URL, and the cookies Better Auth set for the flow. */
  startSignIn(cookie: string): Promise<{ url: string; cookie: string }>;
  /** Its end: the person authorizes at the mock, and the browser holding cookie brings the code back. */
  finishSignIn(who: Person, url: string, cookie: string): Promise<Response>;
  /** Runs the worker's jobs until stopWorker or close. */
  startWorker(): void;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
};

/** The token in a setup link's fragment. */
export const tokenOf = (link: string | null) =>
  new URLSearchParams(new URL(link ?? "https://x/").hash.slice(1)).get(
    "token",
  ) ?? "";

/** Cookie headers joined; a later cookie of the same name wins, as in a browser. */
export function joined(...headers: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of headers.join("; ").split("; ").filter(Boolean)) {
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** `environment` adds settings the deployment's environment sets, beside the mock's addresses. */
export async function startSetup(
  environment: Record<string, string> = {},
): Promise<SetupFixture> {
  const tenant = sampleTenant({ public_base_url: TEST_PUBLIC_BASE_URL });
  const mock = await startMockPowerBi({ tenant });
  // As the deployment's environment points a stack at another cloud.
  const env = {
    POWERBI_AUTHORITY: mock.url,
    POWERBI_API_URL: `${mock.url}/powerbi`,
    POWERBI_GRAPH_URL: `${mock.url}/graph`,
    ...environment,
  };
  const fetcher = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([mock.url]),
    nodeEnv: "test",
  });
  const draft = createTestDeps();
  const identityDir = await mkdtemp(join(tmpdir(), "pbmb-identity-"));
  const identities = await publishedIdentities(draft.db);
  const build = (container: Container) => {
    // The api's identity volume, private as the image makes it, for the security step.
    const volume: Record<string, string> =
      container === "api" ? { IDENTITY_DIR: identityDir } : {};
    const base = createTestDeps({
      container,
      config: testConfig(container, volume),
    });
    const settings = createSettingsStore(base.db, env);
    const identity = identities[container];
    return createTestDeps({
      ...base,
      settings,
      secrets: createSecretReader(
        { container, db: base.db, env: {} },
        identity,
      ),
      vault: createVault(base.config, identity),
      access: cerbosAccess(settings),
      fetcher,
    });
  };
  const api = build("api");
  const worker = build("worker");
  const app = createApp(api);
  let stop = new AbortController();
  let running: Promise<void> | null = null;
  const fromPeer = async (path: string, init: RequestInit = {}) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: freshPeer() } },
    });
  const post = async (
    path: string,
    cookie: string,
    body: object = {},
    headers: Record<string, string> = {},
  ) =>
    fromPeer(path, {
      method: "POST",
      headers: {
        cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  async function startSignIn(cookie: string) {
    const started = await post("/api/auth/sign-in/social", cookie, {
      provider: "microsoft",
      callbackURL: "/setup",
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    return { url, cookie: cookies(started) };
  }
  async function finishSignIn(who: Person, url: string, cookie: string) {
    mock.setActingUser(who.object_id);
    const authorized = await request(url);
    await authorized.body.dump();
    const back = new URL(String(authorized.headers.location));
    return fromPeer(`${back.pathname}${back.search}`, { headers: { cookie } });
  }

  return {
    app,
    api,
    worker,
    mock,
    tenant,
    person: (mailbox) => {
      const found = tenant.people.find(
        (p) => p.email === `${mailbox}@sample.example`,
      );
      if (found === undefined)
        throw new Error(`no ${mailbox} in the sample tenant`);
      return found;
    },
    request: fromPeer,
    post,
    async openSession() {
      const link = await newSetupLink(api, { revoke_earlier: false });
      if (link === null)
        throw new Error("an admin exists, so there is no link");
      const token = tokenOf(link);
      const opened = await post("/api/setup/session", "", { token });
      expect(opened.status).toBe(204);
      return cookies(opened);
    },
    startSignIn,
    finishSignIn,
    async signIn(who, cookie) {
      const started = await startSignIn(cookie);
      const flow = joined(cookie, started.cookie);
      const callback = await finishSignIn(who, started.url, flow);
      return { callback, cookie: joined(flow, cookies(callback)) };
    },
    startWorker() {
      running ??= runJobs(worker, { signal: stop.signal });
    },
    async stopWorker() {
      stop.abort();
      await running;
      running = null;
      stop = new AbortController();
    },
    async close() {
      stop.abort();
      await running;
      await mock.close();
      await rm(identityDir, { recursive: true });
    },
  };
}
