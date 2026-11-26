import { type Env, Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../test/deps.js";
import { createApp } from "../app.js";
import type { Principal } from "../principal.js";
import { gate } from "./gate.js";
import { isPublic, PUBLIC_PATHS } from "./public-paths.js";
import { CATALOG_REDIRECTS, SPA_PATHS } from "./static.js";

afterAll(closeTestPools);

const app = createApp(createTestDeps());

/** A route's pattern as a path a client could send: each parameter or wildcard becomes a sample segment. */
function samplePath(pattern: string): string {
  return pattern.replace(/:[^/]+/g, "sample").replace(/\*/g, "sample");
}

/**
 * Every entry in the app's route table, middleware included, asked without a
 * credential. A route is guarded when it answers 401; it must be guarded
 * exactly when it is not public. A route registered ahead of the gate, or
 * outside it, answers something else and is reported.
 */
async function misjudgedRoutes<E extends Env>(
  target: Hono<E>,
): Promise<string[]> {
  const misjudged: string[] = [];
  for (const route of target.routes) {
    const path = samplePath(route.path);
    const method = route.method === "ALL" ? "GET" : route.method;
    const response = await target.request(path, { method });
    if ((response.status === 401) === isPublic(path, method))
      misjudged.push(
        `${route.method} ${route.path} answered ${String(response.status)}`,
      );
  }
  return misjudged;
}

/** Public paths no route answers: a list left behind after its route moved or went. */
function publicPathsWithoutRoute<E extends Env>(
  target: Hono<E>,
  publicPaths: readonly string[],
): string[] {
  const registered = new Set(
    target.routes
      .filter((route) => route.method !== "ALL")
      .flatMap((route) => [route.path, `${route.method} ${route.path}`]),
  );
  // Hono answers HEAD with the GET route, so a HEAD entry needs the GET route.
  return publicPaths.filter(
    (path) => !registered.has(path.replace(/^HEAD /, "GET ")),
  );
}

describe("the public list matches the app's route table", () => {
  it("answers 401 without a credential on a route registered on the app and not on the public list", async () => {
    const extended = createApp(createTestDeps());
    extended.get("/api/v1/added-later", (c) => c.text("open"));
    const response = await extended.request("/api/v1/added-later");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthenticated",
      message: "Sign in first.",
    });
  });

  it("guards every route that is not public, and only those", async () => {
    expect(await misjudgedRoutes(app)).toEqual([]);
  });

  it("points every public path at a route that exists", () => {
    expect(publicPathsWithoutRoute(app, PUBLIC_PATHS)).toEqual([]);
  });

  it("keeps every catalog route in the SPA shell path list", () => {
    expect(
      app.routes
        .filter((route) => route.path.startsWith("/catalog"))
        .map((route) => route.path)
        .filter(
          (path) =>
            path !== "/catalog/categories" &&
            path !== "/catalog/metrics" &&
            !SPA_PATHS.includes(path),
        ),
    ).toEqual([]);
  });

  it("keeps every catalog redirect behind the gate", async () => {
    for (const path of CATALOG_REDIRECTS) {
      expect(isPublic(path, "GET"), path).toBe(false);
      expect((await app.request(path)).status, path).toBe(401);
    }
  });

  it("would catch a route registered ahead of the gate, and a public path with no route", async () => {
    const leaky = new Hono();
    leaky.get("/leak", (c) => c.text("open"));
    leaky.use(gate);
    leaky.get("/health", (c) => c.text("ok"));
    leaky.get("/runs/:id", (c) => c.text("guarded"));
    expect(await misjudgedRoutes(leaky)).toEqual(["GET /leak answered 200"]);
    expect(publicPathsWithoutRoute(leaky, ["/health", "/gone"])).toEqual([
      "/gone",
    ]);
  });
});

describe("a path holding a control character", () => {
  it.each([
    "/%0a",
    "/x%0a",
    "/api/v1/x%0d",
    "/api/v1/metrics/x%0a",
    "/docs/x%0a",
    "/%00",
  ])("is refused with 400 and the security headers: %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("is refused before any credential is asked for", async () => {
    // A signed-out request to an api path is otherwise 401.
    expect((await app.request("/api/v1/metrics/x%0a")).status).toBe(400);
    expect((await app.request("/api/v1/metrics/x")).status).toBe(401);
  });
});

describe("the gate", () => {
  it("answers 401 to a path no route has, rather than saying whether it exists", async () => {
    for (const path of ["/api/v1/metrics", "/api/mcp", "/docsx"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(401);
    }
  });

  it("opens the SPA's shell for GET alone, and no screen's path until its screen lists it", async () => {
    expect(isPublic("/", "GET")).toBe(true);
    expect(isPublic("/assets/index-4f2a.js", "GET")).toBe(true);
    expect(isPublic("/setup", "GET")).toBe(true);
    expect(isPublic("/setup/more", "GET")).toBe(false);
    for (const path of [
      "/catalog",
      "/catalog/search",
      "/catalog/categories/sales",
      "/catalog/categories/sales/orders",
      "/catalog/metrics/net_sales",
      "/catalog/terms",
      "/catalog/terms/Channel",
      "/catalog/datasets/sample-id",
      "/catalog/datasets/sample-id/tables/Sales",
      "/catalog/datasets/sample-id/tables/Sales/folders/Dates%5CFiscal",
      "/catalog/datasets/sample-id/tables/Sales/folders/In%2FOut%5CQ1",
      "/catalog/datasets/sample-id/tables/Sales/columns/Channel",
    ])
      expect(isPublic(path, "GET"), path).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
      expect(isPublic("/catalog", method), method).toBe(false);
    for (const path of [
      "/catalog/categories",
      "/catalog/metrics",
      "/catalog/terms/Channel/extra",
      "/catalog/datasets/sample-id/extra",
      "/catalog/datasets/sample-id/tables",
      "/catalog/datasets/sample-id/tables/Sales/extra",
      "/catalog/datasets/sample-id/tables/Sales/folders",
      "/catalog/datasets/sample-id/tables/Sales/folders/a/b",
      "/catalog/datasets/sample-id/tables/Sales/columns",
      "/catalog/datasets/sample-id/tables/Sales/columns/Channel/extra",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
    const bareCategories = await app.request("/catalog/categories");
    expect(bareCategories.status).toBe(401);
    expect(await bareCategories.json()).toEqual({
      error: "unauthenticated",
      message: "Sign in first.",
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(isPublic("/", method), method).toBe(false);
      expect(isPublic("/setup", method), method).toBe(false);
      expect(isPublic("/assets/index-4f2a.js", method), method).toBe(false);
    }
    for (const path of [
      "/assets",
      "/assets/",
      "/assets/a/b.js",
      "/review/metrics",
      "/review/metrics/x/extra",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
    for (const method of ["POST", "HEAD"])
      expect((await app.request("/", { method })).status, method).toBe(401);
    for (const path of ["/api/v1/me", "/review/metrics/x/extra"])
      expect((await app.request(path)).status, path).toBe(401);
  });

  it("opens the access screens' paths for GET alone, and nothing below them", () => {
    for (const path of [
      "/sign-in",
      "/invite",
      "/forgot-password",
      "/set-password",
      "/oauth/consent",
      "/device",
      "/settings/connections",
    ]) {
      expect(isPublic(path, "GET"), path).toBe(true);
      for (const method of ["POST", "PUT", "DELETE"])
        expect(isPublic(path, method), `${method} ${path}`).toBe(false);
      expect(isPublic(`${path}/x`, "GET"), `${path}/x`).toBe(false);
    }
    expect(isPublic("/api/auth/config", "GET")).toBe(true);
    expect(isPublic("/api/auth/config", "POST")).toBe(false);
  });

  it("opens each admin page's path for GET alone, and no path near one", async () => {
    expect(isPublic("/admin/pii", "GET")).toBe(true);
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"])
      expect(isPublic("/admin/pii", method), method).toBe(false);
    for (const path of [
      "/admin/pii/",
      "/admin/pii/extra",
      "/api/v1/admin/pii/rules",
      "/api/v1/admin/pii/suggestions",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
    expect(isPublic("/admin/datasets", "GET")).toBe(true);
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"])
      expect(isPublic("/admin/datasets", method), method).toBe(false);
    expect(isPublic("/admin/datasets/", "GET")).toBe(false);
    for (const path of ["/admin", "/admin/powerbi", "/admin/secrets"])
      expect(isPublic(path, "GET"), path).toBe(true);
    for (const path of [
      "/admin/",
      "/admin/a/b",
      "/admin/peoples",
      "/admin/powerbi/",
      "/Admin",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"])
      expect(isPublic("/admin", method), method).toBe(false);
    expect((await app.request("/admin", { method: "POST" })).status).toBe(401);
    expect((await app.request("/admin", { method: "HEAD" })).status).toBe(401);
    expect((await app.request("/admin/peoples")).status).toBe(401);
  });

  it("sends a signed-out browser loading a guarded page to sign in, and back to the address", async () => {
    const page = { accept: "text/html,application/xhtml+xml" };
    // A path a route answers and a path none does get the same answer.
    for (const [path, next] of [
      ["/no-such-page", "%2Fno-such-page"],
      ["/catalog/categories", "%2Fcatalog%2Fcategories"],
      ["/admin/peoples?tab=a&b=c", "%2Fadmin%2Fpeoples%3Ftab%3Da%26b%3Dc"],
      ["//evil.example/x", "%2F%2Fevil.example%2Fx"],
    ] as const) {
      const response = await app.request(path, { headers: page });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        `/sign-in?next=${next}`,
      );
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("vary"), path).toBe("Accept");
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("content-security-policy"), path).toMatch(
        /default-src 'self'/,
      );
      expect(await response.text(), path).toBe("");
    }
  });

  it("leaves an address too long for a response header out of the sign-in link", async () => {
    const response = await app.request(
      `/no-such-page?q=${"%41".repeat(1000)}`,
      {
        headers: { accept: "text/html" },
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("answers 401 to everything else a signed-out client asks for off the list, browser or not", async () => {
    const asked = async (path: string, init: RequestInit) => {
      const response = await app.request(path, init);
      return {
        status: response.status,
        body: await response.json(),
      };
    };
    const refused = { error: "unauthenticated", message: "Sign in first." };
    for (const path of ["/api/v1/me", "/api", "/api/v1/nope", "/api/mcp"])
      expect(
        await asked(path, { headers: { accept: "text/html" } }),
        path,
      ).toEqual({ status: 401, body: refused });
    for (const method of ["POST", "PUT", "DELETE"])
      expect(
        await asked("/no-such-page", {
          method,
          headers: { accept: "text/html" },
        }),
        method,
      ).toEqual({ status: 401, body: refused });
    for (const accept of ["application/json", "*/*"])
      expect(
        await asked("/no-such-page", { headers: { accept } }),
        accept,
      ).toEqual({ status: 401, body: refused });
    // The router decodes the path, and so does the gate's /api check.
    expect(
      await asked("/%61pi/v1/me", { headers: { accept: "text/html" } }),
    ).toEqual({ status: 401, body: refused });
    const head = await app.request("/no-such-page", {
      method: "HEAD",
      headers: { accept: "text/html" },
    });
    expect(head.status).toBe(401);
    expect(head.headers.get("vary")).toBe("Accept");
  });

  it("keeps the bearer challenge for an MCP or API client that sends a token and asks for HTML", async () => {
    for (const path of ["/api/v1/me", "/api/mcp"]) {
      const response = await app.request(path, {
        headers: { accept: "text/html", authorization: "Bearer not-a-token" },
      });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate"), path).toMatch(
        /^Bearer error="invalid_token", resource_metadata=/,
      );
    }
  });

  it("lets on a request that authenticate gave a principal, and no other off the list", async () => {
    const guarded = new Hono<{ Variables: { principal?: Principal } }>();
    guarded.use(async (c, next) => {
      if (c.req.header("x-test-principal") === "viewer")
        c.set("principal", principals.viewer);
      await next();
    });
    guarded.use(gate);
    guarded.get("/private", (c) => c.text("reached"));
    const asked = (headers: Record<string, string>) =>
      guarded.request("/private", { headers });
    expect((await asked({ "x-test-principal": "viewer" })).status).toBe(200);
    expect((await asked({})).status).toBe(401);
  });
});

describe("the setup's public paths", () => {
  it("answer 404 to a request with no setup session and no admin's session", async () => {
    for (const path of PUBLIC_PATHS.filter((p) => p.startsWith("/api/setup"))) {
      const response = await app.request(path, {
        method: path === "/api/setup" ? "GET" : "POST",
        headers: {
          origin: TEST_PUBLIC_BASE_URL,
          "content-type": "application/json",
        },
        body:
          path === "/api/setup" ? null : JSON.stringify({ token: "guessed" }),
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe("isPublic", () => {
  it("opens exactly what the list names", () => {
    expect(PUBLIC_PATHS).toEqual([
      "/health",
      "POST /api/auth/sign-in/email",
      "POST /api/auth/invites/accept",
      "POST /api/auth/invites/lookup",
      "POST /api/auth/email/forgot-password",
      "POST /api/auth/reset-password",
      "/api/auth/sign-in/social",
      "/api/auth/callback/microsoft",
      "/api/auth/callback/google",
      "/api/auth/sign-in/sso",
      "/api/auth/sso/callback",
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
      "/api/auth/dev/sign-in",
      "GET /api/auth/config",
      "GET /api/branding/logo",
      "/api/auth/oauth2/authorize",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/register",
      "/api/auth/device/code",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-protected-resource/api/v1",
      "/api/setup",
      "/api/setup/session",
      "POST /api/setup/tenant",
      "/api/setup/steps/address",
      "/api/setup/steps/app_registration",
      "/api/setup/steps/scanner",
      "/api/setup/steps/what_to_sync",
      "/api/setup/steps/sign_in",
      "/api/setup/steps/who_gets_in",
      "/api/setup/steps/search",
      "/api/setup/steps/agents",
      "/api/setup/steps/first_sync",
      "/api/setup/steps/security",
      "GET /api/v1/results/:id/csv",
      "GET /",
      "GET /assets/:file",
      "GET /sign-in",
      "GET /invite",
      "GET /forgot-password",
      "GET /set-password",
      "GET /oauth/consent",
      "GET /device",
      "GET /settings/connections",
      "GET /admin",
      "GET /admin/powerbi",
      "GET /admin/sign-in",
      "GET /admin/general",
      "GET /admin/search",
      "GET /admin/limits",
      "GET /admin/secrets",
      "GET /setup",
      "GET /admin/people",
      "GET /admin/service-accounts",
      "GET /admin/conventions",
      "GET /admin/audit",
      "GET /admin/datasets",
      "GET /admin/pii",
      "GET /review/metrics/:name",
      "GET /catalog",
      "GET /catalog/guide",
      "GET /catalog/search",
      "GET /catalog/categories/*",
      "GET /catalog/metrics/:name",
      "GET /catalog/terms",
      "GET /catalog/terms/:term",
      "GET /catalog/datasets/:id",
      "GET /catalog/datasets/:id/tables/:table",
      "GET /catalog/datasets/:id/tables/:table/folders/:folder",
      "GET /catalog/datasets/:id/tables/:table/columns/:column",
      "GET /docs",
      "HEAD /docs",
      "GET /docs/*",
      "HEAD /docs/*",
    ]);
    expect(isPublic("/health", "GET")).toBe(true);
    expect(isPublic("/health", "POST")).toBe(true);
    // Better Auth's other paths need a session: signing out, the session, passkey registration.
    for (const path of [
      "/api/auth/sign-out",
      "/api/auth/get-session",
      "/api/auth/passkey/generate-register-options",
      "/api/auth/sso/register",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
  });

  it("opens a result's CSV path for GET alone, for one segment as its id, and nothing near it", () => {
    expect(isPublic("/api/v1/results/7c4f/csv", "GET")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
      expect(isPublic("/api/v1/results/7c4f/csv", method), method).toBe(false);
    for (const path of [
      "/api/v1/results/7c4f/csv/",
      "/api/v1/results//csv",
      "/api/v1/results/a/b/csv",
      "/api/v1/results/7c4f",
      "/api/v1/results/7c4f/csv-link",
      "/api/v1/results/7c4f/csvx",
      "/api/v1/results/csv",
      "/x/api/v1/results/7c4f/csv",
    ])
      expect(isPublic(path, "GET"), path).toBe(false);
  });

  it("opens /docs and everything below it for GET and HEAD alone, and nothing that merely starts with it", () => {
    for (const method of ["GET", "HEAD"])
      for (const path of [
        "/docs",
        "/docs/",
        "/docs/start/quickstart/",
        "/docs/_astro/page.js",
      ])
        expect(isPublic(path, method), `${method} ${path}`).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      for (const path of ["/docs", "/docs/", "/docs/start/"])
        expect(isPublic(path, method), `${method} ${path}`).toBe(false);
    for (const method of ["GET", "HEAD"])
      for (const path of [
        "/docsx",
        "/docs-old/",
        "/x/docs/",
        "/api/docs/",
        "/Docs/",
      ])
        expect(isPublic(path, method), `${method} ${path}`).toBe(false);
  });

  it("answers HEAD /docs/ without a credential, as GET would and with no body", async () => {
    const response = await app.request("/docs/", { method: "HEAD" });
    expect(response.status).not.toBe(401);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not open a path that merely starts or ends like a public one", () => {
    for (const path of [
      "/health/",
      "/health/extra",
      "/healthz",
      "/Health",
      "/api/health",
      "/health/../api/v1",
      "",
    ]) {
      expect(isPublic(path, "GET"), path).toBe(false);
    }
  });
});
