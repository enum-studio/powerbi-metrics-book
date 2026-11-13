import { createRoute } from "@tanstack/react-router";
import { TermsList } from "../../catalog/terms/list";
import { catalogRoute } from "./index";

export const termsRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/terms",
  component: TermsList,
});
export { termRoute } from "./term";
