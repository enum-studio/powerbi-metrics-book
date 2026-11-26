import { pathMatcher } from "./public-paths.js";

/**
 * What a visitor to the public demo may reach, in the format of PUBLIC_PATHS
 * and GET only (HEAD is read as the GET it mirrors). demo.ts answers every
 * other request, before any route: 403 to a method that writes, a redirect
 * to "/" for another screen, and 404 for anything else.
 *
 * The list names what is open, never what is closed, so a route added
 * tomorrow is shut in the demo until someone lists it here.
 * demo_security_test.ts walks the app's route table against it.
 *
 * Every /api/v1 entry is a read whose handler and service write nothing a
 * visitor sends, checked one by one: no GET that starts a sign-in or a
 * connection (/api/v1/powerbi/connect), hands out a link
 * (/api/v1/results/:id/csv), or reads anyone's sessions, tokens, keys,
 * threads, requests or usage. Two writes remain: the rate limiters' counter
 * rows, and one embedding_usage row per search with a provider set
 * (services/search/embedder.ts), priced at the mock's rate, which costs
 * nothing. Search logs nothing while usage.capture is off, which the demo's
 * locks require.
 */
export const DEMO_PATHS: readonly string[] = [
  // Up or down, for the deployment's health check; no data.
  "GET /health",
  // What the SPA reads before anything else: whether this is the demo, and
  // the brand and logo the header shows. Neither names a person.
  "GET /api/auth/config",
  "GET /api/branding/logo",
  // The SPA's shell, which holds no data: index.html and Vite's hashed
  // assets (http/static.ts). "/" is the home screen.
  "GET /",
  "GET /assets/:file",
  // The catalog's screens from SPA_PATHS. Any other screen (sign-in,
  // settings, setup, admin, review) redirects to "/".
  "GET /catalog",
  "GET /catalog/guide",
  "GET /catalog/search",
  "GET /catalog/categories/*",
  "GET /catalog/metrics/:name",
  "GET /catalog/terms",
  "GET /catalog/terms/:term",
  "GET /catalog/datasets/:id",
  "GET /catalog/datasets/:id/tables/:table",
  "GET /catalog/datasets/:id/tables/:table/folders/:folder",
  "GET /catalog/datasets/:id/tables/:table/columns/:column",
  // Bare paths with no screen, redirected to /catalog (CATALOG_REDIRECTS).
  "GET /catalog/categories",
  "GET /catalog/metrics",
  // The docs site: static pages, from apps/docs/dist only (http/docs.ts).
  // "/docs" redirects to "/docs/".
  "GET /docs",
  "GET /docs/*",
  // Who is calling, which the shell reads before the first screen draws
  // (apps/web/src/api/me.ts): here always the demo person.
  "GET /api/v1/me",
  // The home screen: the book's size and search (apps/web/src/home/).
  // Documentation reads are filtered as metric reads are. Export logging
  // stays off under the demo's mandatory usage.capture=false lock.
  "GET /api/v1/guide",
  "GET /api/v1/guide/export",
  "GET /api/v1/book/exports",
  "GET /api/v1/metrics/:name/export",
  "GET /api/v1/book/summary",
  "GET /api/v1/search",
  // The catalog's reads (apps/web/src/catalog/queries.ts and the screens
  // under it): categories, metrics with their variants, terms,
  // workspaces, and datasets with their columns and measures.
  "GET /api/v1/categories",
  "GET /api/v1/metrics",
  "GET /api/v1/metrics/:name",
  "GET /api/v1/metrics/:name/variants",
  "GET /api/v1/variants/:id",
  "GET /api/v1/terms",
  "GET /api/v1/terms/:name",
  "GET /api/v1/workspaces",
  "GET /api/v1/datasets",
  "GET /api/v1/datasets/:id",
  "GET /api/v1/datasets/:id/columns",
  "GET /api/v1/datasets/:id/columns/:column_id",
  "GET /api/v1/datasets/:id/measures",
  // The Documentation tab of a dataset, table and column
  // (apps/web/src/catalog/datasets/documentation.tsx): the element's
  // documentation, read through the same reach and PII checks as the
  // dataset reads above, for those three kinds only, and the conventions,
  // for the custom fields it lists. The conventions name no person and give
  // exceptions as a count per rule, never their targets.
  "GET /api/v1/elements/dataset/:id/docs",
  "GET /api/v1/elements/table/:id/docs",
  "GET /api/v1/elements/column/:id/docs",
  "GET /api/v1/conventions",
];

const demoPath = pathMatcher(DEMO_PATHS);

/** Whether DEMO_PATHS opens this request, read as PUBLIC_PATHS is. */
export function inDemo(path: string, method: string): boolean {
  return demoPath(path, method);
}
