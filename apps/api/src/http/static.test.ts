import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "../../test/deps.js";
import { cookies } from "../../test/sign-in-support.js";
import { createApp } from "../app.js";
import { assignRole } from "../services/auth/roles.js";
import { SPA_PATHS } from "./static.js";

const INDEX =
  '<!doctype html><script type="module" src="/assets/index-4f2a.js"></script>';
const SCRIPT = "console.log('spa')";
/** A docs folder that does not exist, so these tests are about the SPA alone; docs.test.ts has the docs. */
const NO_DOCS = join(tmpdir(), "pbmb-no-docs-dist");

let dist: string;
let cookie: string;
const deps = createTestDeps({
  config: testConfig("api", { ALLOW_DEV_SIGN_IN: "1" }),
});
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "pbmb-web-dist-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), INDEX);
  await writeFile(join(dist, "assets", "index-4f2a.js"), SCRIPT);
  app = createApp(deps, { webDist: dist, docsDist: NO_DOCS });

  const email = `static-${randomUUID().slice(0, 8)}@example.test`;
  await assignRole(
    deps.db,
    { role: "viewer", subject_kind: "person", subject: email },
    principals.admin,
  );
  const signedIn = await app.request("/api/auth/dev/sign-in", {
    method: "POST",
    headers: {
      origin: TEST_PUBLIC_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  expect(signedIn.status).toBe(200);
  cookie = cookies(signedIn);
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
  await closeTestPools();
});

const get = (path: string) => app.request(path, { headers: { cookie } });

/** apps/web/src/routes, read as text: the api has no build-time tie to the web app. */
const WEB_ROUTES = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../web/src/routes",
);

/**
 * Each path the web app routes to: a `path: "..."` in createRoute, or the
 * first argument of a helper that makes one (adminPage("/admin")). TanStack's
 * `$name` is Hono's `:name`.
 */
async function webRoutePaths(): Promise<string[]> {
  const files = await readdir(WEB_ROUTES, { recursive: true });
  const paths = new Set<string>();
  for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
    const source = await readFile(join(WEB_ROUTES, file), "utf8");
    for (const [, rawPath = ""] of source.matchAll(
      /(?:\bpath:\s*|\b\w+\(\s*)"(\/[^"]*)"/g,
    )) {
      let path = rawPath.replace(/\$(\w+)/g, ":$1").replace(/\/\$$/, "/*");
      if (file.startsWith("catalog/"))
        path =
          path === "/"
            ? "/catalog"
            : path.startsWith("/catalog")
              ? path
              : `/catalog${path}`;
      paths.add(path);
    }
  }
  return [...paths].sort();
}

describe("the web app's routes", () => {
  it("are each in SPA_PATHS, so a person can open or reload any of them", async () => {
    const paths = await webRoutePaths();
    expect(paths).toEqual(
      expect.arrayContaining([
        "/sign-in",
        "/admin/secrets",
        "/admin/datasets",
        "/admin/pii",
      ]),
    );
    expect(
      paths.filter((path) => path !== "/" && !SPA_PATHS.includes(path)),
    ).toEqual([]);
  });

  it("are all SPA_PATHS holds", async () => {
    const paths = await webRoutePaths();
    expect(SPA_PATHS.filter((path) => !paths.includes(path))).toEqual([]);
  });
});

describe("the built SPA", () => {
  it.each(["/", ...SPA_PATHS])(
    "answers %s with index.html, never cached",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe(INDEX);
    },
  );

  it("keeps an encoded slash inside one folder segment, and refuses two segments", async () => {
    for (const path of [
      "/catalog/datasets/d1/tables/a%2Fb/folders/q",
      "/catalog/datasets/d1/tables/Sales/folders/In%2FOut%5CQ1",
      "/catalog/datasets/d1/tables/Sales/folders/%2E%2E%2F%2E%2E%2Fadmin",
    ])
      expect((await get(path)).status, path).toBe(200);
    expect(
      (await get("/catalog/datasets/d1/tables/Sales/folders/a/b")).status,
    ).not.toBe(200);
  });

  it.each(["/catalog/categories/sales", "/catalog/categories/sales/orders"])(
    "serves the catalog category path %s through Hono's wildcard route",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX);
    },
  );

  it.each(["/catalog/categories", "/catalog/metrics"])(
    "redirects the bare path %s to the catalog, behind the credential check",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/catalog");
      expect((await app.request(path)).status).toBe(401);
    },
  );

  it.each([
    "/review/metrics",
    "/review/metrics/sample_revenue/extra",
    "/settings",
    "/sign-in/extra",
    "/api/v1/nope",
    "/api",
    "/api/nope",
    "/health/extra",
    "/.well-known/nope",
    "/assets/missing.js",
  ])("never answers %s with index.html", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
    // The app's own not-found answer, the same whether or not the SPA is there.
    expect(await response.text()).toBe("404 Not Found");
  });

  it.each(["/no-such-page", "/settings", "/catalog/terms/Channel/extra"])(
    "answers a browser loading %s with the shell under 404, so the SPA draws its own missing page",
    async (path) => {
      const response = await app.request(path, {
        headers: { cookie, accept: "text/html,application/xhtml+xml" },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("vary")).toBe("Accept");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toMatch(
        /default-src 'self'/,
      );
      expect(await response.text()).toBe(INDEX);
    },
  );

  it.each(["/api/v1/nope", "/api", "/api/nope", "/.well-known/nope"])(
    "keeps %s a plain 404 even when a browser loads it",
    async (path) => {
      const response = await app.request(path, {
        headers: { cookie, accept: "text/html" },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    },
  );

  it.each(["/docs", "/docs/", "/docs/set-up/address/"])(
    "leaves %s to the docs, which here are not built, and never answers it with index.html",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(
        "The docs are not built: run pnpm --filter @powerbi-metrics-book/docs build.",
      );
    },
  );

  it("answers a screen's path to GET only", async () => {
    for (const path of SPA_PATHS) {
      const signedIn = await app.request(path, {
        method: "POST",
        headers: { cookie, origin: TEST_PUBLIC_BASE_URL },
      });
      expect(signedIn.status, path).toBe(404);
      expect(await signedIn.text(), path).toBe("404 Not Found");
      const anonymous = await app.request(path, {
        method: "POST",
        headers: { origin: TEST_PUBLIC_BASE_URL },
      });
      expect(anonymous.status, path).toBe(401);
    }
  });

  it("lets a route registered after the SPA answer its own path", async () => {
    const later = createApp(deps, { webDist: dist, docsDist: NO_DOCS });
    later.get("/api/v1/registered-later", (c) => c.text("later"));
    const response = await later.request("/api/v1/registered-later", {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("later");
  });

  it("serves a hashed asset with a year's cache and its type", async () => {
    const response = await get("/assets/index-4f2a.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await response.text()).toBe(SCRIPT);
  });

  it("serves nothing outside the assets folder, and refuses a control character in the path", async () => {
    for (const path of [
      "/assets/..%2Findex.html",
      "/assets/.hidden",
      "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/%252e%252e%252fpackage.json",
      "/assets/..%5cindex.html",
    ])
      expect((await get(path)).status, path).toBe(404);
    expect((await get("/assets/index-4f2a.js%00.css")).status).toBe(400);
  });

  it("carries the security headers, with the CSP's scripts from self only", async () => {
    const response = await get("/settings/connections");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves the shell without a session, and nothing else of it", async () => {
    const shell = await app.request("/");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe(INDEX);
    expect((await app.request("/assets/index-4f2a.js")).status).toBe(200);
    for (const path of [
      "/review/metrics/x/extra",
      "/admin/powerbi/extra",
      "/admin/datasets/extra",
      "/admin/pii/extra",
      "/api/v1/admin/pii/rules",
      "/api/v1/admin/pii/suggestions",
      "/api/v1/admin/datasets",
      "/api/v1/me",
    ])
      expect((await app.request(path)).status, path).toBe(401);
    expect((await app.request("/admin", { method: "POST" })).status).toBe(401);
    // A screen's own path is the shell, served from SPA_PATHS without a session.
    for (const path of SPA_PATHS) {
      const screen = await app.request(path);
      expect(screen.status, path).toBe(200);
      expect(await screen.text(), path).toBe(INDEX);
    }
  });

  it("says the SPA is not built when there is no dist", async () => {
    const unbuilt = createApp(deps, {
      webDist: join(dist, "missing"),
      docsDist: NO_DOCS,
    });
    const response = await unbuilt.request("/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      "The SPA is not built: run pnpm --filter @powerbi-metrics-book/web build.",
    );
  });

  it("serves what was built at start, not what changed after", async () => {
    await writeFile(join(dist, "index.html"), "changed");
    await writeFile(join(dist, "assets", "later.js"), SCRIPT);
    expect(await (await get("/")).text()).toBe(INDEX);
    expect((await get("/assets/later.js")).status).toBe(404);
  });
});
