import type { MiddlewareHandler } from "hono";
import { ServiceError } from "../errors.js";

/**
 * Paths a state-changing request may reach without this origin, because the
 * caller is not a browser on this site: an OAuth client's token and
 * registration endpoints and the CLI's device authorization endpoint. The
 * token and device endpoints read no cookie. Registration reads a session
 * when one comes, which is harmless: it takes only JSON, which no form can
 * send and no page can send without a preflight, and grants nothing until a
 * person presses Allow. Each entry is an exact path, as in public-paths.ts.
 */
export const ORIGIN_CHECK_EXEMPT: readonly string[] = [
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/register",
  "/api/auth/device/code",
];

const EXEMPT = new Set(ORIGIN_CHECK_EXEMPT);
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A request a cross-site page cannot make: it carries a bearer token and no
 * cookie. A page can add an Authorization header only through a CORS
 * preflight, which the api never allows, so such a request is not a
 * browser's ambient credential and its token alone judges it. One that
 * also carries a cookie is checked like any cookie request.
 */
function bearerOnly(
  authorization: string | undefined,
  cookie: string | undefined,
): boolean {
  return cookie === undefined && /^Bearer \S/i.test(authorization ?? "");
}

/**
 * A state-changing request must say it comes from this site: its Origin must
 * be PUBLIC_BASE_URL's origin, scheme, host and port alike. A request with no
 * Origin is refused too, since every browser sends one on these methods and a
 * cross-site form that could strip it is exactly what this stops.
 */
export function originCheck(publicBaseUrl: URL): MiddlewareHandler {
  const expected = publicBaseUrl.origin;
  return async (c, next) => {
    if (
      !STATE_CHANGING.has(c.req.method) ||
      EXEMPT.has(c.req.path) ||
      bearerOnly(c.req.header("Authorization"), c.req.header("Cookie")) ||
      c.req.header("Origin") === expected
    )
      return next();
    throw new ServiceError(
      "refused",
      `This request did not come from ${expected}. Send it from that address, with its Origin header.`,
    );
  };
}
