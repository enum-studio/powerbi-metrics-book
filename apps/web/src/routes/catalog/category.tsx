import { createRoute } from "@tanstack/react-router";
import { CategoryPage } from "../../catalog/categories/page";
import { catalogRoute } from "./index";
export const categoryRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/categories/$",
  component: function Category() {
    const { _splat } = categoryRoute.useParams();
    return <CategoryPage path={_splat ?? ""} />;
  },
});
