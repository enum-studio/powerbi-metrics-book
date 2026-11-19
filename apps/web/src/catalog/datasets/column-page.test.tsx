import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { ColumnPage } from "./column-page";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("../../shell/breadcrumb", async (original) => ({
  ...(await original<typeof import("../../shell/breadcrumb")>()),
  Crumb: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

function render(missing = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(["catalog", "dataset", "d1"], {
    name: "Sales model",
    workspace: { name: "Commerce" },
  });
  client.setQueryData(["catalog", "dataset", "d1", "table", "Sales"], {
    columns: missing ? [] : [{ id: "c1", name: "Year" }],
  });
  client.setQueryData(["conventions"], {
    rules: {
      element_fields: {
        custom: [{ key: "owner", label: "Owner", type: "text" }],
      },
    },
  });
  client.setQueryData(["catalog", "docs", "column", "c1"], {
    description: "<b>Fiscal year</b>",
    description_pbi: null,
    described_at: null,
    custom: { owner: "Finance team" },
  });
  client.setQueryData(["catalog", "dataset", "d1", "column", "c1"], {
    column: {
      id: "c1",
      name: "Year",
      data_type: "Int64",
      display_folder: "Dates\\Fiscal",
      column_type: "calculated",
      is_hidden: true,
      pii: true,
      format_string: "0",
      expression: "YEAR([Date])",
    },
    terms: [],
    relationships: [],
    used_by: [],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ColumnPage id="d1" table="Sales" column="Year" />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

it("shows the folder trail, badges, properties and DAX, with descriptions as text", () => {
  const html = render();
  expect(html).toMatch(/Commerce.*Sales model.*Dates.*Fiscal/s);
  expect(html).toMatch(
    /Hidden.*Calculated.*PII.*&lt;b&gt;Fiscal year&lt;\/b&gt;.*Owner.*Finance team.*Int64.*YEAR\(\[Date\]\)/s,
  );
  expect(html).toMatch(
    /No terms linked.*No relationships name.*No measures name/s,
  );
});

it("says the column is not there, and links back to its dataset, when the named column is absent", () => {
  const html = render(true);
  expect(html).toContain("No such column");
  expect(html).toContain(
    "There is no column called Year in Sales model that you can see.",
  );
  expect(html).toContain("<a>Go to Sales model</a>");
});

it("fails a dataset the reader may not see as the dataset page does, naming no column", () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, retryOnMount: false },
    },
  });
  client
    .getQueryCache()
    .build(client, { queryKey: ["catalog", "dataset", "d1"] })
    .setState({
      status: "error",
      error: new ApiError(404, "not_found", "No dataset d1 that you may see."),
      fetchStatus: "idle",
    });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ColumnPage id="d1" table="Sales" column="Year" />
    </QueryClientProvider>,
  );
  client.clear();
  expect(html).toContain("Something went wrong");
  expect(html).toContain("No dataset d1 that you may see.");
  expect(html).not.toContain("Year");
});
