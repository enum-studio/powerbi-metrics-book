import { createRoute } from "@tanstack/react-router";
import { GuidePage } from "../../catalog/guide/page";
import { catalogRoute } from "./index";
export const guideRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/guide",
  component: GuidePage,
});
