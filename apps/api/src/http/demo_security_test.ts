import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cerbosAccess, closeTestPools, principals } from "../../test/deps.js";
import { freshPeer, fromSpa, startOAuth } from "../../test/sign-in-support.js";
import { createApp } from "../app.js";
import { assignRole } from "../services/auth/roles.js";
import { DEMO_PERSON_EMAIL } from "../services/demo/person.js";
import { DEMO_PATHS, inDemo } from "./demo-paths.js";
import { pathMatcher } from "./public-paths.js";
import { SPA_PATHS } from "./static.js";

/*
 * In demo mode every request is the demo person, reads only, and reaches
 * only DEMO_PATHS. The app off demo mode, built on the same database, signs
 * people in and hands out the credentials a visitor might bring along.
 */

afterAll(closeTestPools);

const oauth = startOAuth();
// The real policies, so an admin's credential is one the routes behind the
// demo would answer.
const demo = createApp({
  ...oauth.deps,
  access: cerbosAccess(oauth.deps.settings),
  config: { ...oauth.deps.config, demo_mode: true },
});
const fromPeer = (path: string, init?: RequestInit, peer = freshPeer()) =>
  demo.request(path, init, { incoming: { socket: { remoteAddress: peer } } });

const isScreen = pathMatcher(SPA_PATHS);
const WRITES = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** A route's pattern as a path a client could send, as public-paths_security_test.ts makes it. */
const samplePath = (pattern: string) =>
  pattern.replace(/:[^/]+/g, "sample").replace(/\*/g, "sample");

describe("before the demo person exists", () => {
  it("answers 503 on the api, and the sign-in config as the demo", async () => {
    const me = await fromPeer("/api/v1/me");
    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({
      error: "unavailable",
      message: "The demo is being set up. Try again in a minute.",
    });
    const config = await fromPeer("/api/auth/config");
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({
      demo: true,
      dev_sign_in: false,
      providers: [],
    });
  });
});

describe("with the demo person seeded", () => {
  let admin: { cookie: string; email: string };
  let token: string;

  beforeAll(async () => {
    await assignRole(
      oauth.deps.db,
      { role: "viewer", subject_kind: "person", subject: DEMO_PERSON_EMAIL },
      principals.admin,
    );
    const seeded = await oauth.request(
      "/api/auth/dev/sign-in",
      fromSpa("", { email: DEMO_PERSON_EMAIL }),
    );
    expect(seeded.status).toBe(200);
    const person = await oauth.person();
    await assignRole(
      oauth.deps.db,
      { role: "admin", subject_kind: "person", subject: person.email },
      principals.admin,
    );
    admin = person;
    token = (await oauth.login(person.cookie)).access_token;
  });

  it("refuses a write with 403: The demo is read-only.", async () => {
    const answer = await fromPeer(
      "/api/v1/threads",
      fromSpa(admin.cookie, { title: "Hello" }),
    );
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({
      error: "refused",
      message: "The demo is read-only.",
    });
  });

  it("answers 403 to every write on every route, and 404 or a redirect home to every unlisted GET", async () => {
    const paths = [...new Set(demo.routes.map(({ path }) => samplePath(path)))];
    const judged = await Promise.all(
      paths.flatMap((path) => [
        ...WRITES.map(async (method) => {
          const { status } = await fromPeer(path, { method });
          return status === 403
            ? []
            : [`${method} ${path} answered ${String(status)}`];
        }),
        (async () => {
          if (inDemo(path, "GET")) return [];
          const read = await fromPeer(path);
          const home = isScreen(path, "GET");
          return read.status === (home ? 302 : 404) &&
            (!home || read.headers.get("location") === "/")
            ? []
            : [`GET ${path} answered ${String(read.status)}`];
        })(),
      ]),
    );
    expect(paths.length).toBeGreaterThan(100);
    expect(judged.flat()).toEqual([]);
  });

  it("lists GET alone", () => {
    expect(DEMO_PATHS.filter((entry) => !entry.startsWith("GET /"))).toEqual(
      [],
    );
  });

  // A new GET route a DEMO_PATHS pattern happens to match fails here, rather
  // than opening in the demo unseen.
  it("opens these GET routes and no other", () => {
    const opened = demo.routes
      .filter(
        ({ method, path }) =>
          method === "GET" && inDemo(samplePath(path), "GET"),
      )
      .map(({ path }) => path);
    expect([...new Set(opened)].sort()).toEqual([
      "/",
      "/api/auth/config",
      "/api/branding/logo",
      "/api/v1/book/summary",
      "/api/v1/categories",
      "/api/v1/conventions",
      "/api/v1/datasets",
      "/api/v1/datasets/:id",
      "/api/v1/datasets/:id/columns",
      "/api/v1/datasets/:id/columns/:column_id",
      "/api/v1/datasets/:id/measures",
      "/api/v1/elements/:kind/:id/docs",
      "/api/v1/me",
      "/api/v1/metrics",
      "/api/v1/metrics/:name",
      "/api/v1/metrics/:name/variants",
      "/api/v1/search",
      "/api/v1/terms",
      "/api/v1/terms/:name",
      "/api/v1/variants/:id",
      "/api/v1/workspaces",
      "/assets/:file",
      "/catalog",
      "/catalog/categories",
      "/catalog/categories/*",
      "/catalog/datasets/:id",
      "/catalog/datasets/:id/tables/:table",
      "/catalog/datasets/:id/tables/:table/columns/:column",
      "/catalog/datasets/:id/tables/:table/folders/:folder",
      "/catalog/metrics",
      "/catalog/metrics/:name",
      "/catalog/search",
      "/catalog/terms",
      "/catalog/terms/:term",
      "/docs",
      "/docs/*",
      "/health",
    ]);
  });

  it("opens the docs' root and the catalog's bare paths, which redirect", async () => {
    for (const path of ["/docs", "/catalog/categories", "/catalog/metrics"])
      expect(inDemo(path, "GET")).toBe(true);
    const bare = await fromPeer("/catalog/metrics");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/catalog");
  });

  it("answers as the demo person whatever credential the request carries", async () => {
    for (const headers of [
      { cookie: admin.cookie },
      { authorization: `Bearer ${token}` },
      {},
    ]) {
      const me = await fromPeer("/api/v1/me", { headers });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        email: DEMO_PERSON_EMAIL,
        roles: ["viewer"],
        sign_in_method: "demo",
        via: "browser",
      });
    }
  });

  // Each carries the credential its route would answer, so only the demo's
  // own 404 or 403 passes.
  it.each([
    ["POST", "/api/mcp", "token"],
    ["GET", "/api/mcp", "token"],
    ["POST", "/api/auth/oauth2/register", "token"],
    ["POST", "/api/auth/device/code", "token"],
    ["GET", "/api/setup", "cookie"],
    ["GET", "/api/v1/powerbi/connect", "token"],
    ["GET", "/api/v1/results/x/csv", "token"],
  ])("does not answer %s %s with an admin's %s", async (method, path, via) => {
    const answer = await fromPeer(path, {
      method,
      headers:
        via === "cookie"
          ? { cookie: admin.cookie }
          : { authorization: `Bearer ${token}` },
    });
    expect(answer.status).toBe(method === "GET" ? 404 : 403);
  });

  it("looks the demo person up for an api read alone, not a refusal, a missing route or an asset", async () => {
    const lookup = vi.spyOn(oauth.deps.db, "select");
    try {
      expect(
        (await fromPeer("/api/v1/threads", { method: "POST" })).status,
      ).toBe(403);
      expect((await fromPeer("/api/v1/nothing")).status).toBe(404);
      await fromPeer("/assets/index.js");
      expect(lookup).not.toHaveBeenCalled();
      expect((await fromPeer("/api/v1/me")).status).toBe(200);
      expect(lookup).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("answers as a normal api in an app built without the demo, as the seed's is", async () => {
    const normal = createApp(
      { ...oauth.deps, config: { ...oauth.deps.config, demo_mode: true } },
      { serveDemo: false },
    );
    const peer = { incoming: { socket: { remoteAddress: freshPeer() } } };
    const me = await normal.request("/api/v1/me", {}, peer);
    expect(me.status).toBe(401);
    expect(me.headers.get("set-cookie")).toBeNull();
    const signedIn = await normal.request(
      "/api/v1/me",
      { headers: { cookie: admin.cookie } },
      peer,
    );
    expect(await signedIn.json()).toMatchObject({ email: admin.email });
    expect((await fromPeer("/api/v1/me")).status).toBe(200);
  });

  it("answers 429 with Retry-After to the 241st request in a minute from one address", async () => {
    const peer = freshPeer();
    const statuses: number[] = [];
    for (let at = 0; at < 240; at += 1)
      statuses.push((await fromPeer("/health", {}, peer)).status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const over = await fromPeer("/health", {}, peer);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await fromPeer("/health")).status).toBe(200);
  });
});

describe("with demo mode off", () => {
  it("answers the sign-in config as no demo", async () => {
    const config = await oauth.request("/api/auth/config");
    expect(await config.json()).toMatchObject({ demo: false });
  });
});
