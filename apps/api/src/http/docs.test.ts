import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPools, createTestDeps } from "../../test/deps.js";
import { createApp } from "../app.js";

const THEME_SCRIPT = "document.documentElement.dataset.theme = 'dark'";
const START =
  `<!doctype html><title>What Power BI Metrics Book is</title>` +
  `<script>${THEME_SCRIPT}</script><script type="module" src="/docs/_astro/page.js"></script>`;
const QUICKSTART = "<!doctype html><title>Quickstart</title>";
const NOT_FOUND = "<!doctype html><title>Page not found</title>";
const SPA = '<!doctype html><script src="/assets/index.js"></script>';
const CSS = "body{color:red}";

let root: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pbmb-docs-dist-"));
  const web = join(root, "web");
  const docs = join(root, "docs");
  await mkdir(web);
  await writeFile(join(web, "index.html"), SPA);
  await mkdir(join(docs, "start", "quickstart"), { recursive: true });
  await mkdir(join(docs, "_astro"));
  await mkdir(join(docs, "pagefind"));
  await writeFile(join(docs, "index.html"), START);
  await writeFile(join(docs, "404.html"), NOT_FOUND);
  await writeFile(join(docs, "start", "quickstart", "index.html"), QUICKSTART);
  await writeFile(join(docs, "_astro", "site.abc123.css"), CSS);
  await writeFile(join(docs, "pagefind", "pagefind.js"), "export {}");
  app = createApp(createTestDeps(), { webDist: web, docsDist: docs });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closeTestPools();
});

describe("the docs site at /docs", () => {
  it("answers GET /docs/ with the Start page, to someone not signed in", async () => {
    const response = await app.request("/docs/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe(START);
  });

  it("answers GET /docs/nope with 404 and the site's own page, never the SPA", async () => {
    const response = await app.request("/docs/nope");
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe(NOT_FOUND);
    expect(body).not.toBe(SPA);
  });

  it("answers a page deeper down, and sends a page asked for without its slash to the one with it", async () => {
    const page = await app.request("/docs/start/quickstart/");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(QUICKSTART);
    const redirect = await app.request("/docs/start/quickstart");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/docs/start/quickstart/");
    expect((await app.request("/docs")).headers.get("location")).toBe("/docs/");
  });

  it("caches a hashed file for a year and everything else not at all", async () => {
    const css = await app.request("/docs/_astro/site.abc123.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await app.request("/docs/")).headers.get("cache-control")).toBe(
      "no-cache",
    );
    expect(
      (await app.request("/docs/pagefind/pagefind.js")).headers.get(
        "cache-control",
      ),
    ).toBe("no-cache");
  });

  it("serves only files that were built, by their exact path", async () => {
    for (const path of [
      "/docs/404.html",
      "/docs/index.html",
      "/docs/_astro/",
      "/docs/_astro/missing.css",
      "/docs/..%2Findex.html",
      "/docs/%2e%2e/web/index.html",
      "/docs/start/../../web/index.html",
      "/docsx",
    ])
      expect((await app.request(path)).status, path).not.toBe(200);
  });

  it("carries the security headers, with a CSP that allows this page's inline script by its hash alone", async () => {
    const response = await app.request("/docs/");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const hash = createHash("sha256").update(THEME_SCRIPT).digest("base64");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain(
      `script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'`,
    );
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("gives a file no inline script, and the SPA's pages the api's own policy", async () => {
    const file = await app.request("/docs/_astro/site.abc123.css");
    expect(file.headers.get("content-security-policy")).toContain(
      "script-src 'self' 'wasm-unsafe-eval';",
    );
    const health = await app.request("/health");
    expect(health.headers.get("content-security-policy")).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });

  it("opens GET only: any other method is turned away as unauthenticated", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await app.request("/docs/", { method })).status, method).toBe(
        401,
      );
  });

  it("says the docs are not built when there is no dist", async () => {
    const unbuilt = createApp(createTestDeps(), {
      webDist: join(root, "web"),
      docsDist: join(root, "missing"),
    });
    const response = await unbuilt.request("/docs/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      "The docs are not built: run pnpm --filter @powerbi-metrics-book/docs build.",
    );
  });
});
