import { createRoute } from "@tanstack/react-router";
import { SetPassword } from "../access/set-password";
import { rootRoute } from "./root";

export const setPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true, authPage: "Set password" },
  path: "/set-password",
  validateSearch: (search: Record<string, unknown>) => ({
    kind: typeof search.kind === "string" ? search.kind : undefined,
  }),
  component: function SetPasswordScreen() {
    return <SetPassword {...setPasswordRoute.useSearch()} />;
  },
});
