import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { TablePage, type TableTab } from "./table-page";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("../../shell/breadcrumb", async (original) => ({
  ...(await original<typeof import("../../shell/breadcrumb")>()),
  Crumb: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const dataset = {
  name: "Sales model",
  workspace: { name: "Commerce" },
  synced_at: "2026-11-19T06:30:00Z",
  relationships_source: "info_view",
  relationships_note: null,
  relationships: [
    {
      from_table: "Sales",
      from_column: "Date key",
      to_table: "Date",
      to_column: "Date",
      cardinality: "many_to_one",
      cross_filtering_behavior: "one_direction",
      is_active: true,
    },
    {
      from_table: "Stock",
      from_column: "Date key",
      to_table: "Date",
      to_column: "Date",
      cardinality: "many_to_one",
      cross_filtering_behavior: "one_direction",
      is_active: true,
    },
  ],
  tables: [
    {
      id: "t1",
      name: "Sales",
      kind: "fact",
      is_hidden: false,
      description: null,
      description_pbi: null,
    },
  ],
};

const listed = {
  display_folder: null,
  description: null,
  description_pbi: null,
  is_hidden: false,
};
const fields = {
  measures: [
    {
      ...listed,
      id: "m1",
      name: "Net sales",
      format_string: "#,0",
      metric: null,
    },
  ],
  columns: [
    { ...listed, id: "c1", name: "Amount", data_type: "Decimal" },
    { ...listed, id: "c2", name: "Date key", data_type: "Int64" },
  ],
};

function render({
  tab,
  table = "Sales",
  tableFields = fields,
}: {
  tab?: TableTab;
  table?: string;
  tableFields?: unknown;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, retryOnMount: false },
    },
  });
  client.setQueryData(["catalog", "dataset", "d1"], dataset);
  client.setQueryData(["conventions"], {
    rules: {
      element_fields: {
        custom: [
          { key: "grain", label: "Grain", type: "text" },
          { key: "owner", label: "Owner", type: "text" },
        ],
      },
    },
  });
  client.setQueryData(["catalog", "docs", "table", "t1"], {
    description: "One row per order line.",
    description_pbi: "Order lines.",
    described_at: null,
    custom: { grain: "One order line" },
  });
  const key = ["catalog", "dataset", "d1", "table", table];
  if (tableFields instanceof Error)
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({ status: "error", error: tableFields, fetchStatus: "idle" });
  else client.setQueryData(key, tableFields);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TablePage id="d1" table={table} tab={tab} onTab={() => undefined} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

it("opens on the documentation, with its tabs and no diagram", () => {
  const html = render();
  expect(html).toMatch(
    /Documentation.*Columns 2.*Measures 1.*Relationships 1/s,
  );
  expect(html).not.toContain("Diagram");
  expect(html).toMatch(
    /One row per order line\..*Description in Power BI.*Order lines\..*Grain.*One order line.*Owner.*Not written yet.*Fact table/s,
  );
});

it("lists only columns on the Columns tab", () => {
  const html = render({ tab: "columns" });
  expect(html).toContain("<a>Amount</a>");
  expect(html).not.toContain("Net sales");
});

it("lists only measures on the Measures tab", () => {
  const html = render({ tab: "measures" });
  expect(html).toContain("Net sales");
  expect(html).not.toContain("Amount");
});

it("shows only this table's relationships", () => {
  const html = render({ tab: "relationships" });
  expect(html).toContain("Sales");
  expect(html).not.toContain("Stock");
});

it("answers a table the api will not show like one the dataset does not hold", () => {
  const hidden = render({
    tableFields: new ApiError(404, "not_found", "No such table."),
  });
  expect(hidden).toContain("No such table");
  expect(render({ table: "Nope" })).toContain(
    "There is no table called Nope in Sales model that you can see.",
  );
});
