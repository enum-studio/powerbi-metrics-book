import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { captureFragmentToken } from "./access/fragment-token";
import { adminRoute } from "./routes/admin";
import { adminPages } from "./routes/admin/pages";
import { deviceRoute } from "./routes/device";
import { indexRoute } from "./routes/index";
import { reviewMetricRoute } from "./routes/review-metric";
import { oauthConsentRoute } from "./routes/oauth-consent";
import { rootRoute } from "./routes/root";
import { settingsConnectionsRoute } from "./routes/settings-connections";
import { setupRoute } from "./routes/setup";
import { forgotPasswordRoute } from "./routes/forgot-password";
import { setPasswordRoute } from "./routes/set-password";
import { inviteRoute } from "./routes/invite";
import { signInRoute } from "./routes/sign-in";
import { catalogRoute, catalogIndexRoute } from "./routes/catalog";
import { guideRoute } from "./routes/catalog/guide";
import { categoryRoute } from "./routes/catalog/category";
import { searchRoute } from "./routes/catalog/search";
import { metricRoute } from "./routes/catalog/metric";
import { termsRoute, termRoute } from "./routes/catalog/terms";
import { tableRoute } from "./routes/catalog/table";
import { folderRoute } from "./routes/catalog/folder";
import { columnRoute } from "./routes/catalog/column";
import { datasetRoute } from "./routes/catalog/dataset";
import { ErrorState, Loading } from "./shell/states";

/**
 * Code-based routes: one module per screen in src/routes/. A screen's issue
 * adds one import above and one entry below, and nothing is generated.
 */
export const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  inviteRoute,
  forgotPasswordRoute,
  setPasswordRoute,
  oauthConsentRoute,
  deviceRoute,
  settingsConnectionsRoute,
  adminRoute.addChildren(adminPages),
  setupRoute,
  reviewMetricRoute,
  catalogRoute.addChildren([
    catalogIndexRoute,
    guideRoute,
    searchRoute,
    categoryRoute,
    metricRoute,
    termsRoute,
    termRoute,
    datasetRoute,
    tableRoute,
    folderRoute,
    columnRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  captureFragmentToken();
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // A screen's own data waits under TanStack Query; the router does not cache it again.
    defaultPreloadStaleTime: 0,
    // A screen's loading and failure show inside the shell, under its header.
    defaultPendingComponent: () => <Loading what="the page" />,
    defaultErrorComponent: ({ error }) => <ErrorState error={error} />,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
