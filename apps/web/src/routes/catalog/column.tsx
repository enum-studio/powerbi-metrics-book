import { createRoute } from "@tanstack/react-router";
import { ColumnPage } from "../../catalog/datasets/column-page";
import { catalogRoute } from "./index";

export const columnRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/datasets/$id/tables/$table/columns/$column",
  component: function Page() {
    const { id, table, column } = columnRoute.useParams();
    return <ColumnPage id={id} table={table} column={column} />;
  },
});
