import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getMimeType } from "hono/utils/mime";

/** apps/docs/dist, from src/http in a checkout and from dist/http in the image, which keeps the layout under /app. */
export const DOCS_DIST = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../docs/dist",
);

/** Where Astro builds the site to (`base` in apps/docs/astro.config.mjs). */
const BASE = "/docs";

const NOT_BUILT =
  "The docs are not built: run pnpm --filter @powerbi-metrics-book/docs build.";

type File = {
  body: Buffer<ArrayBuffer>;
  type: string;
  cache: string;
  /** The Content-Security-Policy that fits this file; only a page holds scripts. */
  policy: string;
};

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The text of each inline element of this tag; an element with a src has none. */
function inlineText(html: string, tag: "script" | "style"): string[] {
  const element = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(element)]
    .filter(
      ([, attributes, text]) =>
        !/\ssrc=/.test(attributes ?? "") && text !== "" && text !== undefined,
    )
    .map(([, , text]) => text ?? "");
}

/**
 * The CSP that fits Starlight's output. What it needs beyond the api's own
 * policy (security-headers.ts):
 * - the theme switch and a few small scripts are inline, so each page allows
 *   exactly the inline scripts it holds, by hash, and no other;
 * - the search (Pagefind) runs WebAssembly;
 * - Starlight's icons set `style="--sl-icon-size: 1em"`, so style attributes
 *   are allowed, which no script can use to run code;
 * - its CSS draws icons from data: images.
 */
function policyFor(html: string): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", "'wasm-unsafe-eval'", ...inlineText(html, "script").map(sha256)].join(" ")}`,
    `style-src ${["'self'", ...inlineText(html, "style").map(sha256)].join(" ")}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** What a path under /docs that is not a page gets: no inline script is allowed. */
const FILE_POLICY = policyFor("");

/** Every file under dist, or none when the site is not built. */
function listFiles(dist: string): Dirent[] {
  try {
    return readdirSync(dist, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile(),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

/** The site's files by the path they are served at; dist is read once, at start. */
function readSite(dist: string): {
  files: Map<string, File>;
  notFound: File | null;
} {
  const files = new Map<string, File>();
  let notFound: File | null = null;
  for (const entry of listFiles(dist)) {
    const absolute = join(entry.parentPath, entry.name);
    const name = relative(dist, absolute).split(sep).join("/");
    const body = readFileSync(absolute);
    const file: File = {
      body,
      type: getMimeType(name) ?? "application/octet-stream",
      // Astro hashes the names under _astro; every other file keeps its name
      // and is asked for again.
      cache: name.startsWith("_astro/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      policy: name.endsWith(".html")
        ? policyFor(body.toString("utf8"))
        : FILE_POLICY,
    };
    if (name === "404.html") notFound = file;
    else if (name === "index.html" || name.endsWith("/index.html"))
      files.set(`${BASE}/${name.slice(0, -"index.html".length)}`, file);
    else files.set(`${BASE}/${name}`, file);
  }
  return { files, notFound };
}

/**
 * The built docs site, served at /docs to anyone: it holds no data, so the
 * public list opens `GET /docs` and `GET /docs/*` (public-paths.ts) and
 * nothing else. A request can name only a file that was in dist at start, by
 * its exact path; no path a request sends reaches the file system. Anything
 * else under /docs answers the site's own 404 page with status 404, never the
 * SPA's shell.
 *
 * It returns the routes and the middleware that sets the CSP. The middleware
 * must be registered before securityHeaders: that sets its own policy after
 * the handler runs, so the outer layer has the last word.
 */
export function docsSite(dist: string): {
  routes: Hono;
  contentSecurityPolicy: MiddlewareHandler;
} {
  const { files, notFound } = readSite(dist);
  const routes = new Hono();

  const serve = (c: Context) => {
    if (files.size === 0) return c.text(NOT_BUILT, 404);
    const found = files.get(c.req.path);
    if (found === undefined) {
      // A page asked for without its trailing slash, as Astro builds them.
      if (files.has(`${c.req.path}/`)) return c.redirect(`${c.req.path}/`, 301);
      c.header("Cache-Control", "no-cache");
      return notFound === null
        ? c.text("Not found.", 404)
        : c.body(notFound.body, 404, { "Content-Type": notFound.type });
    }
    c.header("Cache-Control", found.cache);
    return c.body(found.body, 200, { "Content-Type": found.type });
  };
  routes.get(BASE, serve);
  routes.get(`${BASE}/*`, serve);

  const contentSecurityPolicy: MiddlewareHandler = async (c, next) => {
    await next();
    const path = c.req.path;
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return;
    const page =
      files.get(path) ?? (c.res.status === 404 ? notFound : undefined);
    c.header("Content-Security-Policy", page?.policy ?? FILE_POLICY);
  };

  return { routes, contentSecurityPolicy };
}
