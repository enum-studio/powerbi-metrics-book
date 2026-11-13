import { useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, Navigate, redirect } from "@tanstack/react-router";
import { SEARCH_KINDS, type HomeSearch } from "../catalog/search/model";
import { signInConfigQuery } from "../access/api";
import { meQuery } from "../api/me";
import { useDemo } from "../shell/demo";
import { Home } from "../home/home";
import { rootRoute } from "./root";

/** The trust states of a crafted URL: strings only, and none when none is left, as the filters panel leaves it. */
function trustStates(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const states = value.filter(
    (state): state is string => typeof state === "string",
  );
  return states.length > 0 ? states : undefined;
}

/** `/` is a signed-in person's search; anyone else goes to sign in. */
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    q: typeof search.q === "string" ? search.q : undefined,
    kind: SEARCH_KINDS.find((kind) => kind === search.kind),
    trust: trustStates(search.trust),
    workspace:
      typeof search.workspace === "string" ? search.workspace : undefined,
    dataset: typeof search.dataset === "string" ? search.dataset : undefined,
    category: typeof search.category === "string" ? search.category : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(meQuery);
    if (me !== null) return;
    // The demo has no sign-in: the server answers it with the demo person.
    const config = await context.queryClient.query(signInConfigQuery);
    if (!config.demo) redirect({ href: "/sign-in", throw: true });
  },
  component: HomeScreen,
});

function HomeScreen() {
  const { data: me } = useSuspenseQuery(meQuery);
  const search = indexRoute.useSearch();
  // The session can end while the page is open.
  const demo = useDemo();
  if (me === null) return demo ? null : <Navigate to="/sign-in" replace />;
  return <Home me={me} search={search} />;
}
