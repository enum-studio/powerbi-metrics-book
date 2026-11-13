import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * The browser-facing rules every response carries. The CSP allows only this
 * origin, all the built SPA needs: no inline script, no data: URL.
 * frame-ancestors repeats X-Frame-Options for browsers that read only one.
 * form-action holds because no flow submits a form: consent, the device code
 * and sign-in post JSON with fetch, and the SPA navigates to the answer.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const MAX_BODY_BYTES = 1024 * 1024;

const privateReferrer = (path: string) =>
  ["/setup", "/api/setup", "/set-password"].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

/**
 * HSTS only when the public address is https: sent over plain http, a
 * development stack on localhost would pin every other localhost service to
 * https in that browser.
 */
export function securityHeaders(publicBaseUrl: URL): MiddlewareHandler {
  const hsts = publicBaseUrl.protocol === "https:";
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    // Password and setup links carry credentials; neither page names itself to another request.
    c.header(
      "Referrer-Policy",
      privateReferrer(c.req.path) ? "no-referrer" : "same-origin",
    );
    if (c.req.path === "/api/setup" || c.req.path.startsWith("/api/setup/"))
      c.header("Cache-Control", "no-store");
    if (hsts)
      c.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
  };
}

/**
 * Refuses a body over 1 MiB before any handler reads it: at once when
 * Content-Length says so, and part way through when a streamed body passes
 * the limit.
 */
export const bodySizeLimit: MiddlewareHandler = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      { error: "invalid", message: "The request body is larger than 1 MiB." },
      413,
    ),
});
