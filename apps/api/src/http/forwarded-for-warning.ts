import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import type { AppDeps } from "../context.js";
import { apiConfig } from "../services/auth/better-auth.js";
import { untrustedForwarder } from "../services/auth/client-address.js";
import { peerOf } from "./peer.js";

const WARN_EVERY_MS = 60_000;
/** Connections named in one round of lines; requests from any more are counted on one line without a peer. */
const NAMED_PEERS = 16;
const MESSAGE = "X-Forwarded-For from a connection outside TRUSTED_PROXY";

/**
 * Warns, at most once a minute, that X-Forwarded-For came from connections
 * outside TRUSTED_PROXY: a line for each connection, with how many requests
 * it sent since the last round. The api counts such a request by its
 * connection and drops the header, which is right for a client that sent the
 * header itself. Behind a proxy whose address changed, such as Traefik
 * recreated on a Dokploy server, every request does it, and one line names
 * the proxy's new address. Any container that reaches the api can send the
 * header too and get a line of its own, so a line is a reason to look the
 * proxy's address up, never the address to set. Each connection is counted
 * on its own, so one that sends many requests cannot push another's line out.
 * No line holds the header's value, which whoever sent it chose.
 */
export function forwardedForWarning(
  deps: Pick<AppDeps, "config" | "logger" | "clock">,
): MiddlewareHandler<AppEnv> {
  const config = apiConfig(deps.config);
  const requests = new Map<string, number>();
  let unnamed = 0;
  let warnedAt: number | null = null;
  return async (c, next) => {
    const peer = untrustedForwarder(peerOf(c.env), c.req.raw.headers, config);
    if (peer !== null) {
      const count = requests.get(peer);
      if (count !== undefined) requests.set(peer, count + 1);
      else if (requests.size < NAMED_PEERS) requests.set(peer, 1);
      else unnamed += 1;
      const now = deps.clock().getTime();
      // A clock set back counts as due, or the lines would stop until it caught up.
      if (
        warnedAt === null ||
        now < warnedAt ||
        now - warnedAt >= WARN_EVERY_MS
      ) {
        const trusted_proxy = config.trusted_proxy;
        for (const [named, sent] of requests)
          deps.logger.warn(MESSAGE, {
            peer: named,
            trusted_proxy,
            requests: sent,
          });
        if (unnamed > 0)
          deps.logger.warn(MESSAGE, {
            peer: null,
            trusted_proxy,
            requests: unnamed,
          });
        requests.clear();
        unnamed = 0;
        warnedAt = now;
      }
    }
    await next();
  };
}
