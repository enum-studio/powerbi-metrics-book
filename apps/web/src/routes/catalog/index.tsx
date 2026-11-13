import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../../api/me";
import { MetricsHome } from "../../catalog/categories/home";
import { rootRoute } from "../root";
export const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalog",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.query(meQuery);
    if (me === null)
      redirect({
        href: `/sign-in?next=${encodeURIComponent(location.href)}`,
        throw: true,
      });
  },
});
export const catalogIndexRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { view?: "not-filed" } =>
    search.view === "not-filed" ? { view: "not-filed" } : {},
  component: function Home() {
    const { view } = catalogIndexRoute.useSearch();
    return <MetricsHome notFiledOnly={view === "not-filed"} />;
  },
});
