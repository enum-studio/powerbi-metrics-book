import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/me";
import { signInConfigQuery } from "../access/api";
import { safeNext } from "../access/links";
import { SignIn } from "../access/sign-in";
import { rootRoute } from "./root";

type Search = { next?: string; error?: string; password?: string };

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/** An MCP client's authorization that sent the person here: Better Auth's signed query, as it arrived. */
function oauthArrival(): string | null {
  const raw = window.location.search.slice(1);
  return new URLSearchParams(raw).has("sig") ? raw : null;
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true, authPage: "Sign in" },
  path: "/sign-in",
  validateSearch: (search: Record<string, unknown>): Search => ({
    next: text(search.next),
    error: text(search.error),
    password: text(search.password),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.query(meQuery);
    if (me !== null && oauthArrival() === null)
      redirect({
        href: safeNext(search.next ?? null, window.location.origin),
        throw: true,
      });
  },
  loader: ({ context }) => context.queryClient.query(signInConfigQuery),
  component: function SignInScreen() {
    const search = signInRoute.useSearch();
    const refusal = search.error ?? null;
    return (
      <SignIn
        next={safeNext(search.next ?? null, window.location.origin)}
        oauthQuery={oauthArrival()}
        refusal={refusal}
        notice={
          search.password === "set"
            ? "Your password is set. Sign in with it."
            : null
        }
      />
    );
  },
});
