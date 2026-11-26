/**
 * What may be reached without a credential. Everything else is behind the
 * gate (gate.ts).
 *
 * The list runs this way round on purpose. A list of protected paths protects
 * a new route only if its author remembers to add it; a list of public paths
 * makes a new route protected by default, and a forgotten public one merely
 * loud.
 *
 * public-paths_security_test.ts walks the app's route table and fails if this
 * list and the routes disagree, in either direction.
 */
export const PUBLIC_PATHS: readonly string[] = [
  "/health",
  // Signing in, before there is a session: services/auth/better-auth.ts.
  "POST /api/auth/sign-in/email",
  "POST /api/auth/invites/accept",
  "POST /api/auth/invites/lookup",
  "POST /api/auth/email/forgot-password",
  "POST /api/auth/reset-password",
  "/api/auth/sign-in/social",
  "/api/auth/callback/microsoft",
  "/api/auth/callback/google",
  "/api/auth/sign-in/sso",
  "/api/auth/sso/callback",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
  // Answers 404 unless NODE_ENV is development or test and ALLOW_DEV_SIGN_IN=1.
  "/api/auth/dev/sign-in",
  // Which of the above the sign-in page offers: routes/auth-config.ts.
  "GET /api/auth/config",
  "GET /api/branding/logo",
  // OAuth for MCP clients and the CLI: services/auth/oauth.ts and device.ts.
  // Authorizing without a session sends the person to sign in first.
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/register",
  "/api/auth/device/code",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-protected-resource/api/v1",
  // The setup API, reached before anyone can sign in: routes/setup.ts.
  // Each route asks for the setup session a link from the api's log opens
  // (the state, the tenant lookup, and the address, app registration and
  // scanner steps only), or an admin's browser
  // session, and answers 404 to anyone else. Once an admin exists no link
  // or setup session works (setup_link_security_test.ts).
  "/api/setup",
  "/api/setup/session",
  "POST /api/setup/tenant",
  "/api/setup/steps/address",
  "/api/setup/steps/app_registration",
  "/api/setup/steps/scanner",
  "/api/setup/steps/what_to_sync",
  "/api/setup/steps/sign_in",
  "/api/setup/steps/who_gets_in",
  "/api/setup/steps/search",
  "/api/setup/steps/agents",
  "/api/setup/steps/first_sync",
  "/api/setup/steps/security",
  // A result's CSV by signed link, GET only: services/queries/csv-access.ts.
  // The link is the credential; a request with a valid one has no other.
  "GET /api/v1/results/:id/csv",
  // The SPA's shell, which holds no data: index.html and Vite's hashed
  // assets (the favicon is one), from apps/web/dist only (http/static.ts).
  // Every datum it shows comes from /api/v1, behind the gate. A screen's own
  // path is opened by the issue that builds the screen, as "GET <path>".
  "GET /",
  "GET /assets/:file",
  "GET /sign-in",
  "GET /invite",
  "GET /forgot-password",
  "GET /set-password",
  "GET /oauth/consent",
  "GET /device",
  "GET /settings/connections",
  // The admin section's screens: the same shell, whose data the admin API
  // gates. Each page is listed on its own, so a route later added under
  // /admin is guarded until it is listed.
  "GET /admin",
  "GET /admin/powerbi",
  "GET /admin/sign-in",
  "GET /admin/general",
  "GET /admin/search",
  "GET /admin/limits",
  "GET /admin/secrets",
  // The setup's screen, opened from a setup link before anyone can sign in.
  // It holds no data: it asks the setup API above, which checks its own credential.
  "GET /setup",
  "GET /admin/people",
  "GET /admin/service-accounts",
  "GET /admin/conventions",
  "GET /admin/audit",
  "GET /admin/datasets",
  "GET /admin/pii",
  // The review page, which a `pbmb metrics request-review` link opens. The
  // shell is public so that the SPA can send someone signed out to sign-in
  // and back; the metric itself is behind /api/v1.
  "GET /review/metrics/:name",
  // The catalog shell holds no data; its screens read everything from /api/v1.
  "GET /catalog",
  "GET /catalog/guide",
  "GET /catalog/search",
  // Categories nest to any depth. This wildcard serves only the shell; nothing below it is a route.
  "GET /catalog/categories/*",
  "GET /catalog/metrics/:name",
  "GET /catalog/terms",
  "GET /catalog/terms/:term",
  "GET /catalog/datasets/:id",
  "GET /catalog/datasets/:id/tables/:table",
  // A display folder's whole path is one segment: its levels joined with a backslash, escaped. The shell only.
  "GET /catalog/datasets/:id/tables/:table/folders/:folder",
  "GET /catalog/datasets/:id/tables/:table/columns/:column",
  // The docs site: static pages and files that hold no data, from
  // apps/docs/dist only (http/docs.ts). "/docs/*" ends in a wildcard, which
  // opens everything under /docs/ and nothing beside it.
  // HEAD too, for link checkers and uptime probes: Hono answers it with the
  // GET route's headers and no body.
  "GET /docs",
  "HEAD /docs",
  "GET /docs/*",
  "HEAD /docs/*",
];

const escaped = (segment: string) =>
  segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a list in PUBLIC_PATHS's format into a test of a request: an exact
 * match on the path Hono routes by, with a `:name` segment matching one
 * non-empty segment, and on the method when the entry names one. No
 * trailing slash is forgiven: Hono routes strictly, so /health/ is not the
 * health route, and the gate answering 401 for it is the safe way to
 * disagree. demo-paths.ts reads its own list with it.
 */
export function pathMatcher(
  list: readonly string[],
): (path: string, method: string) => boolean {
  /** An entry is a path, or "METHOD path" to open that method alone; a path alone opens every method. */
  const entries = list.map((entry) => {
    const [method, path] = entry.startsWith("/")
      ? [null, entry]
      : (entry.split(" ") as [string, string]);
    // A `:name` segment stands for exactly one segment of the request's path, as it does in the route.
    // A final `*` stands for the rest of the path, empty or not, so "/docs/*" opens "/docs/" and everything below it.
    const segments = path.split("/");
    const rest = segments.at(-1) === "*";
    const pattern = new RegExp(
      `^${segments
        .slice(0, rest ? -1 : undefined)
        .map((segment) =>
          segment.startsWith(":") ? "[^/]+" : escaped(segment),
        )
        .join("/")}${rest ? "/.*" : ""}$`,
    );
    return { method, pattern };
  });
  return (path, method) =>
    entries.some(
      (entry) =>
        (entry.method === null || entry.method === method) &&
        entry.pattern.test(path),
    );
}

const publicPath = pathMatcher(PUBLIC_PATHS);

/** Whether PUBLIC_PATHS opens this request, read by pathMatcher. */
export function isPublic(path: string, method: string): boolean {
  return publicPath(path, method);
}
