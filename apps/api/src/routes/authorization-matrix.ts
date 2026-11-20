/**
 * Who gets past authorization on every route and every connector tool, for
 * each kind of caller; authorization_matrix_security_test.ts proves each cell
 * with a real request on the sample tenant. The cells follow the spec's rules:
 * - Each credential works only where it is meant to: a browser session off
 *   /api/mcp, an OAuth token on the resource it was issued for, an API key on
 *   /api/v1 alone.
 * - Every element-addressed cell is about the sample's Sales dataset, which
 *   the viewer reaches through the Sales app, the curator through the
 *   Analysts group, the admin as a workspace admin and the granted service
 *   account through its grant. To the outsider, the service account with no
 *   grant and the curator elsewhere (a curator outside its audience) it
 *   answers as a missing one, curation included.
 * - Curation needs a curator or an admin, approval a person's browser
 *   session, the conventions and the admin section an admin. Both service
 *   accounts hold viewer. A result is read by whoever ran its query alone.
 */

export const ROUTE_CALLERS = [
  "anonymous",
  "outsider",
  "viewer",
  "curator",
  "admin",
  "curator_elsewhere",
  "service_account",
  "service_account_granted",
  "curator_cli_token",
  "curator_mcp_token",
] as const;
export type RouteCaller = (typeof ROUTE_CALLERS)[number];

/** On /api/mcp every caller but an MCP client is turned away before any tool runs. */
export const TOOL_CALLERS = [
  "anonymous",
  "outsider",
  "viewer",
  "curator",
  "admin",
  "curator_elsewhere",
  "service_account",
  "service_account_granted",
  "curator_session",
  "curator_cli_token",
] as const;
export type ToolCaller = (typeof TOOL_CALLERS)[number];

/**
 * - allowed: past authorization; the request does what it asks.
 * - unauthenticated: 401, the credential is missing or not one this path takes.
 * - refused: 403, and the same answer for a target that does not exist.
 * - hidden: 404, with exactly the answer a target that does not exist gets.
 */
export type Verdict = "allowed" | "unauthenticated" | "refused" | "hidden";

export type RouteCells = Readonly<Record<RouteCaller, Verdict>>;
export type ToolCells = Readonly<Record<ToolCaller, Verdict>>;

const routeCells = (
  verdict: Verdict,
  changes: Partial<Record<RouteCaller, Verdict>>,
): RouteCells => ({
  anonymous: verdict,
  outsider: verdict,
  viewer: verdict,
  curator: verdict,
  admin: verdict,
  curator_elsewhere: verdict,
  service_account: verdict,
  service_account_granted: verdict,
  curator_cli_token: verdict,
  curator_mcp_token: verdict,
  ...changes,
});

/** The public list: no credential needed, and none in the way. */
const PUBLIC = routeCells("allowed", {});
/** Better Auth's session routes and the SPA's screens: a browser session alone; a bearer credential means nothing off /api/v1 and /api/mcp. */
const SESSION = routeCells("unauthenticated", {
  outsider: "allowed",
  viewer: "allowed",
  curator: "allowed",
  admin: "allowed",
  curator_elsewhere: "allowed",
});
/** OAuth's own endpoints read an Authorization header as the client's credential, and take no bearer one. */
const OAUTH: RouteCells = { ...SESSION, anonymous: "allowed" };
/** The connector takes an MCP client's token and nothing else. */
const CONNECTOR = routeCells("unauthenticated", {
  curator_mcp_token: "allowed",
});
/** Anyone with a credential /api/v1 takes. */
const SIGNED_IN = routeCells("allowed", {
  anonymous: "unauthenticated",
  curator_mcp_token: "unauthenticated",
});
/** Filtered by dataset:describe: the Sales dataset, or an element in it. */
const SEES_SALES: RouteCells = {
  ...SIGNED_IN,
  outsider: "hidden",
  service_account: "hidden",
  curator_elsewhere: "hidden",
};
/** A thread's accept and archive: the thread is the admin's question, so curators and admins. */
const THREAD_CURATORS: RouteCells = {
  ...SEES_SALES,
  viewer: "refused",
  service_account_granted: "refused",
};
/** book:curate and book:verify: curators and admins. */
const CURATORS = routeCells("refused", {
  anonymous: "unauthenticated",
  curator: "allowed",
  admin: "allowed",
  curator_elsewhere: "allowed",
  curator_cli_token: "allowed",
  curator_mcp_token: "unauthenticated",
});
/** Curation of a metric, variant, column or dataset in Sales: a curator who cannot see it finds nothing. */
const CURATES_SALES: RouteCells = { ...CURATORS, curator_elsewhere: "hidden" };
/** admin actions and book:edit_conventions. */
const ADMINS = routeCells("refused", {
  anonymous: "unauthenticated",
  admin: "allowed",
  curator_mcp_token: "unauthenticated",
});
/** A person's own grants and Power BI connection; a service account has neither. */
const PEOPLE: RouteCells = {
  ...SIGNED_IN,
  service_account: "refused",
  service_account_granted: "refused",
};
/** Answered in a browser, signed in to this site: never with a token. */
const IN_BROWSER: RouteCells = { ...PEOPLE, curator_cli_token: "refused" };
/** The setup API: an admin's browser session once an admin exists; to anyone else it is not there. */
const SETUP = routeCells("hidden", { admin: "allowed" });
/** The curator ran the query; nobody else reads its result. */
const RESULT_OWNER = routeCells("hidden", {
  anonymous: "unauthenticated",
  curator: "allowed",
  curator_cli_token: "allowed",
  curator_mcp_token: "unauthenticated",
});
/** The curator's request: its principal and the curators read it, and to anyone else it is not there. */
const REQUEST_READERS = routeCells("hidden", {
  anonymous: "unauthenticated",
  curator: "allowed",
  admin: "allowed",
  curator_elsewhere: "allowed",
  curator_cli_token: "allowed",
  curator_mcp_token: "unauthenticated",
});

/** Every route of the app, as `METHOD path` in its route table. */
export const ROUTE_MATRIX = {
  "GET /health": PUBLIC,
  "POST /api/auth/sign-in/email": PUBLIC,
  "POST /api/auth/invites/accept": PUBLIC,
  "POST /api/auth/invites/lookup": PUBLIC,
  "POST /api/auth/email/forgot-password": PUBLIC,
  "POST /api/auth/reset-password": PUBLIC,
  "POST /api/auth/change-password": SESSION,
  "POST /api/v1/admin/people/invites": ADMINS,
  "POST /api/auth/sign-in/social": PUBLIC,
  "GET /api/auth/callback/microsoft": PUBLIC,
  "GET /api/auth/callback/google": PUBLIC,
  "POST /api/auth/sign-in/sso": PUBLIC,
  "GET /api/auth/sso/callback": PUBLIC,
  "GET /api/auth/passkey/generate-authenticate-options": PUBLIC,
  "POST /api/auth/passkey/verify-authentication": PUBLIC,
  "POST /api/auth/dev/sign-in": PUBLIC,
  "GET /api/auth/config": PUBLIC,
  "GET /api/branding/logo": PUBLIC,
  "GET /api/auth/oauth2/authorize": PUBLIC,
  "POST /api/auth/oauth2/token": OAUTH,
  "POST /api/auth/oauth2/register": OAUTH,
  "POST /api/auth/device/code": OAUTH,
  "GET /api/auth/get-session": SESSION,
  "GET /api/auth/passkey/generate-register-options": SESSION,
  "POST /api/auth/passkey/verify-registration": SESSION,
  "GET /api/auth/passkey/list-user-passkeys": SESSION,
  "POST /api/auth/passkey/delete-passkey": SESSION,
  "GET /.well-known/oauth-authorization-server": PUBLIC,
  "GET /.well-known/oauth-authorization-server/api/auth": PUBLIC,
  "GET /.well-known/oauth-protected-resource/api/mcp": PUBLIC,
  "GET /.well-known/oauth-protected-resource/api/v1": PUBLIC,
  "POST /api/mcp": CONNECTOR,
  "GET /api/mcp": CONNECTOR,
  "PUT /api/mcp": CONNECTOR,
  "PATCH /api/mcp": CONNECTOR,
  "DELETE /api/mcp": CONNECTOR,
  "GET /api/v1/me": SIGNED_IN,
  "GET /api/v1/me/connection": PEOPLE,
  "GET /api/v1/me/grants": PEOPLE,
  "DELETE /api/v1/me/grants/:id": PEOPLE,
  "GET /api/v1/powerbi/connect": IN_BROWSER,
  "GET /api/v1/powerbi/callback": IN_BROWSER,
  "GET /api/v1/drafts/next": CURATORS,
  "POST /api/v1/metrics": CURATORS,
  "PATCH /api/v1/metrics/:name": CURATES_SALES,
  "POST /api/v1/metrics/:name/merge": CURATES_SALES,
  "POST /api/v1/metrics/:name/verify": CURATES_SALES,
  "POST /api/v1/metrics/:name/dismiss": CURATES_SALES,
  "DELETE /api/v1/metrics/:name": CURATES_SALES,
  "GET /api/v1/metrics/:name/checks": CURATES_SALES,
  "GET /api/v1/metrics/:name/history": CURATES_SALES,
  "PATCH /api/v1/variants/:id": CURATES_SALES,
  "POST /api/v1/categories/:path{.+}": CURATORS,
  "PATCH /api/v1/categories/:path{.+}": CURATORS,
  "DELETE /api/v1/categories/:path{.+}": CURATORS,
  "POST /api/v1/terms/:name": CURATORS,
  "PATCH /api/v1/terms/:name": CURATORS,
  "DELETE /api/v1/terms/:name": CURATORS,
  "PUT /api/v1/terms/:name/columns/:column_id": CURATES_SALES,
  "DELETE /api/v1/terms/:name/columns/:column_id": CURATES_SALES,
  "PUT /api/v1/terms/:name/metrics/:metric": CURATES_SALES,
  "DELETE /api/v1/terms/:name/metrics/:metric": CURATES_SALES,
  "PUT /api/v1/elements/:kind/:id/docs": CURATES_SALES,
  "PUT /api/v1/elements/:kind/:id/icon": CURATES_SALES,
  "DELETE /api/v1/elements/:kind/:id/icon": CURATES_SALES,
  // trust.human_verify_from: browser, the default, refuses a token.
  "POST /api/v1/metrics/:name/approve": {
    ...CURATES_SALES,
    curator_cli_token: "refused",
  },
  "PUT /api/v1/conventions": ADMINS,
  "GET /api/v1/conventions/company": ADMINS,
  "GET /api/v1/conventions/versions": ADMINS,
  "POST /api/v1/conventions/diff": ADMINS,
  "POST /api/v1/conventions/apply": ADMINS,
  // As GET /api/v1/metrics/:name/checks, asked for one metric in Sales.
  "GET /api/v1/conventions/exceptions/unused": CURATES_SALES,
  // As GET /api/v1/conventions: the rules' values are the conventions'.
  "GET /api/v1/conventions/rules": SIGNED_IN,
  // powerbi.service_account_queries is off by default.
  "POST /api/v1/queries": { ...SEES_SALES, service_account_granted: "refused" },
  "GET /api/v1/queries": SIGNED_IN,
  // The default policy lets everyone signed in read the whole query log's DAX.
  "GET /api/v1/queries/:id": SIGNED_IN,
  "GET /api/v1/results/:id": RESULT_OWNER,
  "POST /api/v1/results/:id/csv-link": RESULT_OWNER,
  // Public for its signed link, which anonymous holds here; anyone else
  // shows their own credential, which only the owner's opens. A token this
  // path does not take is answered 401 when no link was sent.
  "GET /api/v1/results/:id/csv": { ...RESULT_OWNER, anonymous: "allowed" },
  "POST /api/v1/requests": SIGNED_IN,
  "GET /api/v1/usage/report": CURATORS,
  "GET /api/v1/requests": SIGNED_IN,
  "GET /api/v1/requests/:id": REQUEST_READERS,
  // A curator reads another's request and may not delete it.
  "DELETE /api/v1/requests/:id": {
    ...REQUEST_READERS,
    curator_elsewhere: "refused",
  },
  "POST /api/v1/threads": SEES_SALES,
  "GET /api/v1/threads": SIGNED_IN,
  "GET /api/v1/threads/:id": SEES_SALES,
  "POST /api/v1/threads/:id/replies": SEES_SALES,
  "PUT /api/v1/threads/:id/upvote": SEES_SALES,
  "DELETE /api/v1/threads/:id/upvote": SEES_SALES,
  "POST /api/v1/threads/:id/accept": THREAD_CURATORS,
  "POST /api/v1/threads/:id/archive": THREAD_CURATORS,
  "GET /api/v1/search": SIGNED_IN,
  "GET /api/v1/conventions": SIGNED_IN,
  "GET /api/v1/book/summary": SIGNED_IN,
  "GET /api/v1/metrics": SIGNED_IN,
  "GET /api/v1/metrics/:name": SEES_SALES,
  "GET /api/v1/metrics/:name/variants": SEES_SALES,
  "GET /api/v1/variants/:id": SEES_SALES,
  "GET /api/v1/categories": SIGNED_IN,
  "GET /api/v1/terms": SIGNED_IN,
  "GET /api/v1/terms/:name": SIGNED_IN,
  "GET /api/v1/workspaces": SIGNED_IN,
  "GET /api/v1/apps": SIGNED_IN,
  "GET /api/v1/icons": SIGNED_IN,
  "GET /api/v1/datasets": SIGNED_IN,
  "GET /api/v1/datasets/:id": SEES_SALES,
  "GET /api/v1/datasets/:id/columns": SEES_SALES,
  "GET /api/v1/datasets/:id/columns/:column_id": SEES_SALES,
  "GET /api/v1/datasets/:id/measures": SEES_SALES,
  "GET /api/v1/elements/:kind/:id/docs": SEES_SALES,
  "GET /api/v1/events": SIGNED_IN,
  "GET /api/v1/admin/settings/:key": ADMINS,
  "GET /api/v1/admin/pii/rules": ADMINS,
  "PUT /api/v1/admin/pii/rules": ADMINS,
  "DELETE /api/v1/admin/pii/rules/:id": ADMINS,
  "GET /api/v1/admin/pii/suggestions": ADMINS,
  "GET /api/v1/admin/datasets": ADMINS,
  "PUT /api/v1/admin/datasets/:dataset": ADMINS,
  "PUT /api/v1/admin/settings/:key": ADMINS,
  "GET /api/v1/admin/secrets": ADMINS,
  "PUT /api/v1/admin/secrets/:name": ADMINS,
  "PUT /api/v1/admin/secrets/:name/expiry": ADMINS,
  "POST /api/v1/admin/checks/:name": ADMINS,
  "GET /api/v1/admin/checks/:name": ADMINS,
  // read_status: the shipped policy gives it to admins alone.
  "GET /api/v1/admin/status": ADMINS,
  "GET /api/v1/admin/roles": ADMINS,
  "POST /api/v1/admin/roles": ADMINS,
  "DELETE /api/v1/admin/roles/:id": ADMINS,
  "GET /api/v1/admin/people": ADMINS,
  "PUT /api/v1/admin/people/:id/role": ADMINS,
  "PUT /api/v1/admin/people/:id/pii": ADMINS,
  "POST /api/v1/admin/people/:id/deactivate": ADMINS,
  "POST /api/v1/admin/people/:id/reactivate": ADMINS,
  "POST /api/v1/admin/people/:id/sign-out": ADMINS,
  "DELETE /api/v1/admin/people/:id": ADMINS,
  "GET /api/v1/admin/people/invites": ADMINS,
  "POST /api/v1/admin/people/invites/:id/resend": ADMINS,
  "DELETE /api/v1/admin/people/invites/:id": ADMINS,
  "PUT /api/v1/admin/branding/logo": ADMINS,
  "DELETE /api/v1/admin/branding/logo": ADMINS,
  "POST /api/v1/admin/sync": ADMINS,
  "GET /api/v1/admin/sync": ADMINS,
  "GET /api/v1/admin/service-accounts": ADMINS,
  "POST /api/v1/admin/service-accounts": ADMINS,
  "PATCH /api/v1/admin/service-accounts/:name": ADMINS,
  "DELETE /api/v1/admin/service-accounts/:name": ADMINS,
  "GET /api/v1/admin/service-accounts/:name/keys": ADMINS,
  "POST /api/v1/admin/service-accounts/:name/keys": ADMINS,
  "DELETE /api/v1/admin/service-accounts/:name/keys/:id": ADMINS,
  "DELETE /api/v1/admin/grants/:id": ADMINS,
  "GET /api/v1/admin/audit": ADMINS,
  "GET /api/v1/admin/export": ADMINS,
  "POST /api/v1/admin/import": ADMINS,
  "GET /api/v1/oauth/consent": IN_BROWSER,
  "POST /api/v1/oauth/consent": IN_BROWSER,
  "GET /api/v1/oauth/device": IN_BROWSER,
  "POST /api/v1/oauth/device": IN_BROWSER,
  // A setup link opens nothing once an admin exists, to an admin neither.
  "POST /api/setup/session": routeCells("hidden", {}),
  "GET /api/setup": SETUP,
  "POST /api/setup/tenant": SETUP,
  "POST /api/setup/steps/address": SETUP,
  "POST /api/setup/steps/app_registration": SETUP,
  "POST /api/setup/steps/scanner": SETUP,
  "POST /api/setup/steps/what_to_sync": SETUP,
  "POST /api/setup/steps/sign_in": SETUP,
  "POST /api/setup/steps/who_gets_in": SETUP,
  "POST /api/setup/steps/search": SETUP,
  "POST /api/setup/steps/agents": SETUP,
  "POST /api/setup/steps/first_sync": SETUP,
  "POST /api/setup/steps/security": SETUP,
  // The SPA's shell holds no data; a screen's path opens only once its screen lists it as public.
  "GET /assets/:file": PUBLIC,
  "GET /": PUBLIC,
  "GET /sign-in": PUBLIC,
  "GET /invite": PUBLIC,
  "GET /forgot-password": PUBLIC,
  "GET /set-password": PUBLIC,
  "GET /oauth/consent": PUBLIC,
  "GET /device": PUBLIC,
  "GET /settings/connections": PUBLIC,
  // Each admin page's path serves the same shell, to anyone; the admin API behind it answers 403 to all but an admin.
  "GET /admin": PUBLIC,
  "GET /admin/powerbi": PUBLIC,
  "GET /admin/sign-in": PUBLIC,
  "GET /admin/general": PUBLIC,
  "GET /admin/search": PUBLIC,
  "GET /admin/limits": PUBLIC,
  "GET /admin/secrets": PUBLIC,
  "GET /setup": PUBLIC,
  "GET /admin/people": PUBLIC,
  "GET /admin/service-accounts": PUBLIC,
  "GET /admin/conventions": PUBLIC,
  "GET /admin/audit": PUBLIC,
  "GET /admin/datasets": PUBLIC,
  "GET /admin/pii": PUBLIC,
  "GET /review/metrics/:name": PUBLIC,
  // The catalog shell holds no data; its screens read everything from /api/v1.
  "GET /catalog": PUBLIC,
  "GET /catalog/search": PUBLIC,
  "GET /catalog/categories": SESSION,
  "GET /catalog/categories/*": PUBLIC,
  // Redirects to /catalog, behind the gate like /catalog/categories.
  "GET /catalog/metrics": SESSION,
  "GET /catalog/metrics/:name": PUBLIC,
  "GET /catalog/terms": PUBLIC,
  "GET /catalog/terms/:term": PUBLIC,
  "GET /catalog/datasets/:id": PUBLIC,
  "GET /catalog/datasets/:id/tables/:table": PUBLIC,
  "GET /catalog/datasets/:id/tables/:table/folders/:folder": PUBLIC,
  "GET /catalog/datasets/:id/tables/:table/columns/:column": PUBLIC,
  // The docs site holds no data (http/docs.ts).
  "GET /docs": PUBLIC,
  "GET /docs/*": PUBLIC,
  // Last: they end the caller's other sessions, Power BI connection and session.
  "POST /api/auth/revoke-other-sessions": SESSION,
  "DELETE /api/v1/powerbi/connection": PEOPLE,
  "POST /api/auth/sign-out": SESSION,
} as const satisfies Record<string, RouteCells>;
export type RouteKey = keyof typeof ROUTE_MATRIX;

/** Every person through an MCP client; any other credential is turned away. */
const CONNECTED: ToolCells = {
  anonymous: "unauthenticated",
  outsider: "allowed",
  viewer: "allowed",
  curator: "allowed",
  admin: "allowed",
  curator_elsewhere: "allowed",
  service_account: "unauthenticated",
  service_account_granted: "unauthenticated",
  curator_session: "unauthenticated",
  curator_cli_token: "unauthenticated",
};
const TOOL_SEES_SALES: ToolCells = {
  ...CONNECTED,
  outsider: "hidden",
  curator_elsewhere: "hidden",
};
const TOOL_RESULT_OWNER: ToolCells = {
  ...CONNECTED,
  outsider: "hidden",
  viewer: "hidden",
  admin: "hidden",
  curator_elsewhere: "hidden",
};

/** Every tool of the connector, by name. */
export const TOOL_MATRIX = {
  search: CONNECTED,
  list_metrics: CONNECTED,
  get_metric: TOOL_SEES_SALES,
  list_variants: TOOL_SEES_SALES,
  get_variant: TOOL_SEES_SALES,
  list_categories: CONNECTED,
  list_terms: CONNECTED,
  get_term: CONNECTED,
  get_conventions: CONNECTED,
  list_workspaces: CONNECTED,
  list_apps: CONNECTED,
  list_datasets: CONNECTED,
  get_dataset: TOOL_SEES_SALES,
  list_relationships: TOOL_SEES_SALES,
  list_columns: TOOL_SEES_SALES,
  list_measures: TOOL_SEES_SALES,
  execute_dax: TOOL_SEES_SALES,
  read_query_result: TOOL_RESULT_OWNER,
  get_result_csv_link: TOOL_RESULT_OWNER,
  search_query_log: CONNECTED,
  get_query: CONNECTED,
  post_thread: TOOL_SEES_SALES,
  reply_in_thread: TOOL_SEES_SALES,
  get_thread: TOOL_SEES_SALES,
  list_threads: CONNECTED,
  accept_reply: { ...TOOL_SEES_SALES, viewer: "refused" },
  set_upvote: TOOL_SEES_SALES,
  whoami: CONNECTED,
  record_request: CONNECTED,
  list_requests: CONNECTED,
  get_usage_report: { ...CONNECTED, outsider: "refused", viewer: "refused" },
  get_request: { ...CONNECTED, outsider: "hidden", viewer: "hidden" },
} as const satisfies Record<string, ToolCells>;
export type ToolName = keyof typeof TOOL_MATRIX;
