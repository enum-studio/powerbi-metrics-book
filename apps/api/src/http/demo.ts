import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import type { AppDeps } from "../context.js";
import { ServiceError } from "../errors.js";
import { apiConfig } from "../services/auth/better-auth.js";
import { clientAddress } from "../services/auth/client-address.js";
import { asDemoPerson } from "../services/auth/principal.js";
import { clientAddressKey } from "../services/auth/client-address-key.js";
import { countRequest } from "../services/rate-limit.js";
import { inDemo } from "./demo-paths.js";
import { errorResponse } from "./error-response.js";
import { peerOf } from "./peer.js";
import { isPublic, pathMatcher } from "./public-paths.js";
import { SPA_PATHS } from "./static.js";

/** Requests a minute from one client address; a visitor's screen makes a handful at a time. */
export const DEMO_READS_PER_MINUTE = 240;

const isScreen = pathMatcher(SPA_PATHS);

/**
 * The public demo's own gate, registered only in an app that serves the
 * demo, where authenticate reads no credential, and before the gate. Every
 * request is counted against its address, a write is refused, a screen off
 * the demo goes home, and anything else not in DEMO_PATHS answers as a
 * missing route. Only then is the demo person looked up, and only for a
 * path the gate would refuse without one, so a request turned away, a
 * screen, an asset or the sign-in config costs the limiter's one row write.
 */
export function demoRequests(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const address = clientAddress(
      peerOf(c.env),
      c.req.raw.headers,
      apiConfig(deps.config),
    );
    const verdict = await countRequest(
      deps.db,
      `demo:${address === null ? "in-process" : clientAddressKey(address)}`,
      { window_seconds: 60, max: DEMO_READS_PER_MINUTE },
      deps.clock(),
    );
    if (!verdict.allowed) {
      c.header("Retry-After", String(verdict.retry_after_seconds));
      return errorResponse(
        c,
        new ServiceError(
          "rate_limited",
          `Too many requests. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
        ),
      );
    }
    const { method, path } = c.req;
    if (method !== "GET" && method !== "HEAD")
      return errorResponse(
        c,
        new ServiceError("refused", "The demo is read-only."),
      );
    // Hono answers HEAD with the GET route, so a HEAD is judged as its GET.
    if (!inDemo(path, "GET"))
      return isScreen(path, "GET") ? c.redirect("/", 302) : c.notFound();
    if (isPublic(path, "GET")) return next();
    await asDemoPerson(deps, c);
    if (c.get("principal") === undefined)
      return errorResponse(
        c,
        new ServiceError(
          "unavailable",
          "The demo is being set up. Try again in a minute.",
        ),
      );
    return next();
  };
}
