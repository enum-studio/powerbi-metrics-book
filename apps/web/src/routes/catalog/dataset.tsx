import { createRoute } from "@tanstack/react-router";
import { DatasetPage } from "../../catalog/datasets/page";
import { catalogRoute } from "./index";
const TABS = ["diagram", "tables", "measures", "relationships"] as const;
/** The tab, the table whose panel is open, and the column or measure marked in it, which the tree's rows link to. */
const validateSearch = (
  search: Record<string, unknown>,
): {
  tab: (typeof TABS)[number] | undefined;
  table: string | undefined;
  field?: string;
} => ({
  tab: TABS.find((tab) => tab === search.tab),
  table: typeof search.table === "string" ? search.table : undefined,
  ...(typeof search.field === "string" ? { field: search.field } : {}),
});
export const datasetRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/datasets/$id",
  validateSearch,
  component: function Dataset() {
    const { id } = datasetRoute.useParams();
    const search = datasetRoute.useSearch();
    return (
      <DatasetPage
        id={id}
        tab={search.tab}
        table={search.table}
        field={search.field}
      />
    );
  },
});
