import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import type { Logger } from "../log.js";

/**
 * One line per request, written after the response is made. It names the
 * path without its query string, which can carry a token, and never a
 * header, cookie or body. The request id is the api's own, never one a client
 * sent, and goes back in X-Request-Id so a caller can quote it.
 */
export function requestLog(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    c.set("request_id", requestId);
    c.header("X-Request-Id", requestId);
    await next();
    logger.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(performance.now() - started),
      request_id: requestId,
    });
  };
}
