import { createRoute } from "@tanstack/react-router";
import {
  TABLE_TABS,
  TablePage,
  type TableTab,
} from "../../catalog/datasets/table-page";
import { catalogRoute } from "./index";

/** The tab, and the measure marked on it, which the tree's rows link to. */
const validateSearch = (
  search: Record<string, unknown>,
): { tab?: TableTab; field?: string } => {
  const tab = TABLE_TABS.find((each) => each === search.tab);
  return {
    ...(tab === undefined ? {} : { tab }),
    ...(typeof search.field === "string" ? { field: search.field } : {}),
  };
};

export const tableRoute = createRoute({
  getParentRoute: () => catalogRoute,
  path: "/datasets/$id/tables/$table",
  validateSearch,
  component: function Page() {
    const { id, table } = tableRoute.useParams();
    const { tab, field } = tableRoute.useSearch();
    const navigate = tableRoute.useNavigate();
    return (
      <TablePage
        id={id}
        table={table}
        tab={tab}
        field={field}
        onTab={(next) => {
          void navigate({ search: { tab: next } });
        }}
      />
    );
  },
});
