import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppDeps } from "./context.js";
import { ServiceError } from "./errors.js";
import { demoRequests } from "./http/demo.js";
import { DOCS_DIST, docsSite } from "./http/docs.js";
import { logError } from "./http/error-log.js";
import { errorResponse } from "./http/error-response.js";
import { forwardedForWarning } from "./http/forwarded-for-warning.js";
import { gate } from "./http/gate.js";
import { originCheck } from "./http/origin-check.js";
import { isPageLoad } from "./http/page-load.js";
import { type PeerBindings, peerOf } from "./http/peer.js";
import { requestLog } from "./http/request-log.js";
import { bodySizeLimit, securityHeaders } from "./http/security-headers.js";
import { spaRoutes, spaShell, WEB_DIST } from "./http/static.js";
import { mcpRoutes } from "./mcp/server.js";
import type { Principal } from "./principal.js";
import { passwordDocumentation } from "./routes/auth-password.js";
import {
  brandingRoutes,
  logoBodyLimit,
  logoContentSecurityPolicy,
} from "./routes/branding.js";
import { authConfigRoutes } from "./routes/auth-config.js";
import { v1Routes } from "./routes/v1/index.js";
import { setupRoutes } from "./routes/setup.js";
import { oauthRoutes } from "./routes/v1/oauth.js";
import {
  createAuth,
  PUBLIC_AUTH_ROUTES,
  SESSION_AUTH_ROUTES,
} from "./services/auth/better-auth.js";
import {
  bearerChallenge,
  protectedResourceMetadata,
  REQUEST_ID,
  servedMetadata,
} from "./services/auth/oauth.js";
import {
  authenticate,
  type SignedInPerson,
} from "./services/auth/principal.js";
import { VERSION } from "./version.js";

export type AppEnv = {
  Bindings: PeerBindings;
  Variables: {
    request_id: string;
    /** Set by authenticate when the request carries a valid credential. */
    principal?: Principal;
    /**
     * Set beside the principal when it is a person, on any channel: the
     * email and name of their user row, for /api/v1/me alone. A service
     * account has none.
     */
    identity?: { email: string; name: string };
    /** Set beside the principal for a browser session only: the readers of it ask for a session. */
    person?: SignedInPerson;
    /** Set by authenticate when a bearer token was sent and not taken. */
    bearer_refusal?: "invalid_token" | "insufficient_scope";
  };
};

export type AppOptions = {
  /** The built SPA; a test passes a folder of its own. */
  webDist?: string;
  /** The built docs; a test passes a folder of its own. */
  docsDist?: string;
  /**
   * Whether this app is the public demo: every request the demo person,
   * read-only, on DEMO_PATHS. Defaults to config.demo_mode; the sample seed,
   * which runs in the demo's environment, builds its own app with false.
   */
  serveDemo?: boolean;
};

export function createApp(
  deps: AppDeps,
  {
    webDist = WEB_DIST,
    docsDist = DOCS_DIST,
    serveDemo = deps.config.demo_mode,
  }: AppOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = createAuth(deps);
  const docs = docsSite(docsDist);

  // The log first, so a request turned away below is logged too, and the
  // warning about a stale TRUSTED_PROXY, which names the log's request id.
  // Then the docs' policy, outside the headers so it replaces theirs for
  // /docs (the pages need hashed inline scripts); then the headers, so every
  // answer carries them, the body limit, the bearer challenge, which tells an
  // OAuth client turned away below where to sign in, authenticate, which sets the principal a valid credential names, the
  // gate ahead of every route (public-paths_security_test.ts checks it), and
  // the origin check for whatever the gate lets through.
  app.use(requestLog(deps.logger));
  app.use(forwardedForWarning(deps));
  app.use(docs.contentSecurityPolicy);
  const headers = securityHeaders(deps.config.public_base_url);
  // The same layer, called by hand below with this app's context.
  const putOnHeaders: (
    c: Context<AppEnv>,
    next: () => Promise<void>,
  ) => Promise<unknown> = headers;
  app.use(logoContentSecurityPolicy);
  app.use(headers);
  // Right after the headers, so the refusal carries them.
  app.use(async (c, next) => {
    if (hasControlCharacter(c.req.path)) return refuse(c);
    await next();
  });
  app.use("/api/v1/admin/branding/logo", logoBodyLimit);
  app.use(bodySizeLimit);
  app.use(bearerChallenge(deps.config.public_base_url));
  app.use(authenticate(deps, auth, serveDemo));
  // The public demo answers every request it does not open itself.
  if (serveDemo) app.use(demoRequests(deps));
  app.use(gate);
  app.use(originCheck(deps.config.public_base_url));

  app.get("/health", async (c) => {
    try {
      await deps.pool.query("select 1");
    } catch (error) {
      deps.logger.warn("health check failed", {
        request_id: c.get("request_id"),
        error: String(error),
      });
      return c.json({ ok: false }, 503);
    }
    return c.json({ ok: true, version: VERSION, git_sha: deps.config.git_sha });
  });

  // Better Auth, on the paths sign-in needs and no others: any other path
  // under /api/auth has no route, and answers 404 to a signed-in person.
  const toAuth = (c: Context<AppEnv>) =>
    auth.handle(withRequestId(c), peerOf(c.env));
  for (const route of [...PUBLIC_AUTH_ROUTES, ...SESSION_AUTH_ROUTES]) {
    const documentation = passwordDocumentation.find(
      ({ path }) => path === route.path,
    );
    if (documentation)
      app.on(route.method, route.path, documentation.document, toAuth);
    else app.on(route.method, route.path, toAuth);
  }
  // What the sign-in page offers, ours rather than Better Auth's.
  app.route("/", authConfigRoutes(deps));
  app.route("/", brandingRoutes(deps));

  // OAuth discovery: the authorization server at the root, where pbmb login
  // reads it, and at RFC 8414's path for the issuer /api/auth; each
  // protected resource at RFC 9728's path.
  const authorizationServer = async (c: Context<AppEnv>) =>
    c.json(servedMetadata(await auth.authorizationServer()));
  app.get("/.well-known/oauth-authorization-server", authorizationServer);
  app.get(
    "/.well-known/oauth-authorization-server/api/auth",
    authorizationServer,
  );
  for (const resource of ["mcp", "v1"] as const)
    app.get(`/.well-known/oauth-protected-resource/api/${resource}`, (c) =>
      c.json(protectedResourceMetadata(deps.config.public_base_url, resource)),
    );

  // The connector, for an MCP client's OAuth access token only.
  app.route("/api/mcp", mcpRoutes(deps));
  app.route("/api/v1", v1Routes(deps));
  app.route("/api/v1", oauthRoutes(deps, auth));
  // The first run, before anyone can sign in: each route checks its own credential.
  app.route("/", setupRoutes(deps, auth));
  // The docs before the SPA, whose shell answers every GET path it is given.
  app.route("/", docs.routes);
  // Last, so the SPA answers only what no route above does.
  const shell = spaShell(webDist);
  app.route("/", spaRoutes(webDist, shell));

  // Hono's wildcard middleware cannot match a path holding a line break, so
  // such a path that also matches no route reaches no middleware at all and
  // would get Hono's bare 404. Every unmatched path is answered here instead,
  // with the headers put on by hand. A page load gets the SPA's shell, which
  // draws its own "No page here" and holds no data. A signed-out page load
  // of a path off the public list never gets here: the gate sends it to sign in.
  app.notFound(async (c) => {
    await putOnHeaders(c, () => {
      c.header("Vary", "Accept");
      c.res = hasControlCharacter(c.req.path)
        ? refuse(c)
        : isPageLoad(c)
          ? shell(c, 404)
          : c.text("404 Not Found", 404);
      return Promise.resolve();
    });
    return c.res;
  });

  // A ServiceError is meant for the caller and answers with its own status
  // and message. An HTTPException answers with its own response, as under
  // Hono's default handler. Anything else is a bug: logged, and answered
  // without a word about it.
  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      if (error.kind === "upstream" && error.detail.issues !== undefined) {
        const issues = z
          .array(z.array(z.union([z.string(), z.number()])))
          .safeParse(error.detail.issues);
        if (issues.success)
          deps.logger.error("upstream error", {
            request_id: c.get("request_id"),
            issues: JSON.stringify(issues.data),
          });
      }
      return errorResponse(c, error);
    }
    if (error instanceof HTTPException) return error.getResponse();
    logError(deps.logger, "unhandled error", error, {
      request_id: c.get("request_id"),
    });
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

/** No route takes a control character in its path, and one in a path reaches a log line or a header. The path is already decoded. */
const hasControlCharacter = (path: string) => /\p{Cc}/u.test(path);

const refuse = (c: Context<AppEnv>) =>
  c.json(
    {
      error: "invalid",
      message: "The path holds a control character.",
    },
    400,
  );

/** The request Better Auth sees names the api's own request id, for what it logs; never one the caller sent. */
function withRequestId(c: Context<AppEnv>): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.set(REQUEST_ID, c.get("request_id"));
  return new Request(c.req.raw, { headers });
}
