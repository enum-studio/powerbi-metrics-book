import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../../api/me";
import { MetricPage } from "../../catalog/metrics/page";
import { catalogRoute } from "./index";
export const metricRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/metrics/$name",
  validateSearch: (search: Record<string, unknown>): { variant?: string } =>
    typeof search.variant === "string" ? { variant: search.variant } : {},
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.query(meQuery);
    if (me === null)
      redirect({
        href: `/sign-in?next=${encodeURIComponent(location.href)}`,
        throw: true,
      });
    return { me };
  },
  component: function Metric() {
    const { variant } = metricRoute.useSearch();
    const { name } = metricRoute.useParams();
    const { me } = metricRoute.useRouteContext();
    return me === null ? null : (
      <MetricPage name={name} me={me} variant={variant} />
    );
  },
});
