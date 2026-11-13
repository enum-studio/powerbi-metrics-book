import { createRoute } from "@tanstack/react-router";
import { FolderPage } from "../../catalog/datasets/folder-page";
import { folderLevels } from "../../catalog/tree/folders";
import { catalogRoute } from "./index";

export const folderRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/datasets/$id/tables/$table/folders/$folder",
  component: function Page() {
    const { id, table, folder } = folderRoute.useParams();
    return <FolderPage id={id} table={table} path={folderLevels(folder)} />;
  },
});
