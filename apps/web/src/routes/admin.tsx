import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/me";
import { AdminLayout } from "../admin/layout/admin-layout";
import { rootRoute } from "./root";

/**
 * The admin section's frame, with no path of its own: each page below it
 * carries its full path (/admin, /admin/powerbi, ...), so the api opens one
 * "GET /admin/:page" for them all. Nobody signed out gets past it; whether
 * someone signed in may open a page is the admin API's answer, shown by the
 * layout.
 */
export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(meQuery);
    if (me === null) redirect({ href: "/sign-in", throw: true });
  },
  component: AdminLayout,
});
