import type { MiddlewareHandler } from "hono";
import { ServiceError } from "../errors.js";
import type { Principal } from "../principal.js";
import { errorResponse } from "./error-response.js";
import { isPageLoad, signInFor } from "./page-load.js";
import { isPublic } from "./public-paths.js";

/**
 * Registered ahead of every route, so a route added tomorrow is guarded
 * because nobody listed it as public.
 *
 * It decides on c.req.path, the same decoded path the router matches, so a
 * percent-encoded spelling cannot reach a route the gate did not judge.
 *
 * authenticate runs first and sets c.var.principal from a valid credential.
 * The gate lets on a request that has a principal or asks for a public path.
 * A browser loading any other page is sent to sign in, and back to the
 * address afterwards; every other request is answered 401. Neither says
 * whether a route is there. The route a request reaches still checks the
 * principal itself (requirePrincipal, then Cerbos).
 */
export const gate: MiddlewareHandler<{
  Variables: { principal?: Principal };
}> = async (c, next) => {
  if (isPublic(c.req.path, c.req.method) || c.get("principal") !== undefined)
    return next();
  // Which answer a request gets depends on what it accepts.
  c.header("Vary", "Accept");
  if (isPageLoad(c)) {
    // It depends on the session cookie too, so no cache may keep it.
    c.header("Cache-Control", "no-store");
    return c.redirect(signInFor(c), 302);
  }
  // Answered here rather than thrown, so the gate holds on any Hono app,
  // whatever error handler it has.
  return errorResponse(
    c,
    new ServiceError("unauthenticated", "Sign in first."),
  );
};
