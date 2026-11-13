import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { getMimeType } from "hono/utils/mime";

/** apps/web/dist, from src/http in a checkout and from dist/http in the image, which keeps the layout under /app. */
export const WEB_DIST = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../web/dist",
);

/**
 * The screens' paths, each one an explicit GET route that serves index.html
 * and a "GET <path>" line in public-paths.ts, which the public-paths security
 * test matches exactly. No other path serves the shell. A screen's issue adds
 * its paths here; static.test.ts fails on a web route missing from this list.
 */
export const SPA_PATHS: readonly string[] = [
  "/sign-in",
  "/invite",
  "/forgot-password",
  "/set-password",
  "/oauth/consent",
  "/device",
  "/settings/connections",
  "/admin",
  "/admin/powerbi",
  "/admin/sign-in",
  "/admin/general",
  "/admin/search",
  "/admin/limits",
  "/admin/secrets",
  "/setup",
  "/admin/people",
  "/admin/service-accounts",
  "/admin/conventions",
  "/admin/audit",
  "/admin/datasets",
  "/admin/pii",
  "/review/metrics/:name",
  "/catalog",
  "/catalog/search",
  "/catalog/categories/*",
  "/catalog/metrics/:name",
  "/catalog/terms",
  "/catalog/terms/:term",
  "/catalog/datasets/:id",
  "/catalog/datasets/:id/tables/:table",
  "/catalog/datasets/:id/tables/:table/folders/:folder",
  "/catalog/datasets/:id/tables/:table/columns/:column",
];

/** Bare paths with no screen of their own, sent to the catalog. Not public: the gate answers them first. */
export const CATALOG_REDIRECTS: readonly string[] = [
  "/catalog/categories",
  "/catalog/metrics",
];

const NOT_BUILT =
  "The SPA is not built: run pnpm --filter @powerbi-metrics-book/web build.";

export type SpaShell = (c: Context, status: 200 | 404) => Response;

/**
 * index.html, read once at start. It holds no data: every screen reads its
 * data from /api/v1. Served with 404 to a page load no route answers, so the
 * SPA draws its own "No page here" under the status a missing page has.
 */
export function spaShell(dist: string): SpaShell {
  const index = readIfPresent(join(dist, "index.html"));
  return (c, status) => {
    if (index === null) return c.text(NOT_BUILT, 404);
    c.header("Cache-Control", "no-cache");
    return c.body(index, status, {
      "Content-Type": "text/html; charset=utf-8",
    });
  };
}

/**
 * The built SPA, registered after every other route. Its files never change
 * while the process runs, so they are read once, here: a request can name only
 * a file that was in dist/assets at start, by its exact name, and no path a
 * request sends ever reaches the file system. Vite names each asset by its
 * content, so an asset is cached for a year; index.html names the current
 * ones and is asked for again on every visit. Which of these paths someone
 * not signed in reaches is the public list's decision (public-paths.ts).
 */
export function spaRoutes(dist: string, shell: SpaShell): Hono {
  const routes = new Hono();
  const assets = new Map<string, { body: Buffer<ArrayBuffer>; type: string }>();
  for (const file of listIfPresent(join(dist, "assets"))) {
    const type = getMimeType(file);
    const body = readIfPresent(join(dist, "assets", file));
    if (type !== undefined && body !== null) assets.set(file, { body, type });
  }

  routes.get("/assets/:file", (c) => {
    const asset = assets.get(c.req.param("file"));
    if (asset === undefined) return c.notFound();
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(asset.body, 200, { "Content-Type": asset.type });
  });

  // "/" and each screen's path, and nothing else: any other path reaches a
  // route registered later, or the app's own not-found.
  routes.get("/", (c) => shell(c, 200));
  for (const bare of CATALOG_REDIRECTS)
    routes.get(bare, (c) => c.redirect("/catalog", 302));
  for (const path of SPA_PATHS) routes.get(path, (c) => shell(c, 200));

  return routes;
}

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** A missing file means the SPA is not built (the api's tests run without it); any other failure is thrown. */
function readIfPresent(path: string): Buffer<ArrayBuffer> | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function listIfPresent(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
