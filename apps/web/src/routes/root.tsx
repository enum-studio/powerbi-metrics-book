import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useLocation,
  useMatches,
} from "@tanstack/react-router";
import { signInConfigQuery } from "../access/api";
import { AuthLayout } from "../access/parts";
import { meQuery } from "../api/me";
import { PAGE, Shell } from "../shell/shell";
import { EmptyState, ErrorState } from "../shell/states";
import { browserThemeHost, restoreTheme } from "../shell/theme";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Auth column without the app header, titled for this page. */
    authPage?: string;
  }
}

export type RouterContext = { queryClient: QueryClient };

/** Every screen sits in the shell. Who is signed in is asked before the first screen draws, so their theme is on from the start. */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    const [me] = await Promise.all([
      context.queryClient.query(meQuery),
      context.queryClient.query(signInConfigQuery),
    ]);
    if (me !== null) restoreTheme(browserThemeHost(), me.id);
  },
  component: function RootScreen() {
    const path = useLocation({ select: (location) => location.pathname });
    const authPage = useMatches({
      select: (matches) =>
        matches.find((match) => match.staticData.authPage)?.staticData.authPage,
    });
    return authPage !== undefined ? (
      <AuthLayout key={path} pageTitle={authPage}>
        <Outlet />
      </AuthLayout>
    ) : (
      <Shell>
        <Outlet />
      </Shell>
    );
  },
  // Without knowing who is signed in there is no header to draw: this stands alone.
  errorComponent: ({ error }) => (
    <div className={PAGE}>
      <ErrorState error={error} />
    </div>
  ),
  notFoundComponent: () => (
    <EmptyState
      title="No page here"
      action={
        <Link
          to="/"
          className="text-ui text-accent underline underline-offset-4"
        >
          Go to the start
        </Link>
      }
    >
      This address is not a page of Power BI Metrics Book. Check it for a typo,
      or start again from the beginning.
    </EmptyState>
  ),
});
