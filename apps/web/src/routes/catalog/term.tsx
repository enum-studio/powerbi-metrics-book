import { createRoute } from "@tanstack/react-router";
import { TermPage } from "../../catalog/terms/page";
import { catalogRoute } from "./index";

export const termRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/terms/$term",
  component: function Term() {
    const { term } = termRoute.useParams();
    return <TermPage name={term} />;
  },
});
