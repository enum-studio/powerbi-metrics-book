import type { Context } from "hono";

/**
 * A browser loading a page into its tab: a GET that asks for HTML, outside
 * the APIs and the OAuth metadata. A browser's navigation always asks for
 * text/html; the SPA's own fetches ask for JSON, and an API client asks for
 * what it reads, so both keep the API's JSON answers.
 */
export function isPageLoad(c: Context): boolean {
  if (c.req.method !== "GET") return false;
  const path = c.req.path;
  if (
    path === "/api" ||
    path.startsWith("/api/") ||
    path.startsWith("/.well-known/")
  )
    return false;
  return (c.req.header("Accept") ?? "").includes("text/html");
}

/** Longer than this, the address is left out: a proxy may refuse a response header that long. */
const MAX_NEXT = 2048;

/** Sign-in, and the address the browser asked for, as it sent it, to come back to. */
export function signInFor(c: Context): string {
  const url = new URL(c.req.url);
  const next = encodeURIComponent(`${url.pathname}${url.search}`);
  return next.length > MAX_NEXT ? "/sign-in" : `/sign-in?next=${next}`;
}
