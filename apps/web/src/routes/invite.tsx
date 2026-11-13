import { createRoute } from "@tanstack/react-router";
import { Invite } from "../access/invite";
import { rootRoute } from "./root";

export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true, authPage: "Invite" },
  path: "/invite",
  component: Invite,
});
