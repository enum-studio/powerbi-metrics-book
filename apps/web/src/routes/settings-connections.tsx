import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/me";
import { connectionQuery, grantsQuery, signInConfigQuery } from "../access/api";
import { Connections } from "../access/connections";
import { SettingsBreadcrumb } from "../admin/layout/admin-layout";
import { rootRoute } from "./root";

export const settingsConnectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connections",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(meQuery);
    if (me === null)
      redirect({
        href: "/sign-in?next=%2Fsettings%2Fconnections",
        throw: true,
      });
  },
  // Every tab's data before the screen draws: the route's pending and error states cover them all.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.query(signInConfigQuery),
      context.queryClient.query(connectionQuery),
      context.queryClient.query(grantsQuery),
    ]),
  component: () => (
    <>
      <SettingsBreadcrumb />
      <Connections />
    </>
  ),
});
