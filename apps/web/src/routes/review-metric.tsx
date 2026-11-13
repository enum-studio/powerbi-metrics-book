import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * Keep links already sent to the review address working by sending them to
 * the catalog's one metric page.
 */
export const reviewMetricRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review/metrics/$name",
  beforeLoad: ({ params }) =>
    redirect({
      to: "/catalog/metrics/$name",
      params: { name: params.name },
      throw: true,
    }),
});
