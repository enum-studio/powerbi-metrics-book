import { createRoute } from "@tanstack/react-router";
import { FolderPage } from "../../catalog/datasets/folder-page";
import { catalogRoute } from "./index";

export const tableRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/datasets/$id/tables/$table",
  component: function Page() {
    const { id, table } = tableRoute.useParams();
    return <FolderPage id={id} table={table} path={[]} />;
  },
});
