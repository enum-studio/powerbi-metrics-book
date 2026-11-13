import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { FieldBreadcrumb, FolderPage } from "./folder-page";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("../../shell/breadcrumb", async (original) => ({
  ...(await original<typeof import("../../shell/breadcrumb")>()),
  Crumb: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const dataset = { name: "Sales model", workspace: { name: "Commerce" } };

it("links the table crumb for an ordinary table", () => {
  const html = renderToStaticMarkup(
    <FieldBreadcrumb
      id="d1"
      dataset={dataset}
      table="Sales"
      path={["Dates"]}
    />,
  );
  expect(html).toContain("<a>Sales</a>");
  expect(html).toContain('title="Commerce"');
});

it("shows a table named .. as text, not a crumb link", () => {
  const html = renderToStaticMarkup(
    <FieldBreadcrumb id="d1" dataset={dataset} table=".." path={["Dates"]} />,
  );
  expect(html).not.toContain("<a>..</a>");
  expect(html).toContain('<span title=".." class="block truncate">..</span>');
});

function renderPage({
  dataset,
  fields,
  table = "Sales",
}: {
  dataset: unknown;
  fields?: unknown;
  table?: string;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, retryOnMount: false },
    },
  });
  const put = (key: unknown[], value: unknown) => {
    if (value instanceof Error)
      client
        .getQueryCache()
        .build(client, { queryKey: key })
        .setState({ status: "error", error: value, fetchStatus: "idle" });
    else if (value !== undefined) client.setQueryData(key, value);
  };
  put(["catalog", "dataset", "d1"], dataset);
  put(["catalog", "dataset", "d1", "table", table], fields);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FolderPage id="d1" table={table} path={[]} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

const model = {
  ...dataset,
  tables: [{ name: "Sales", description: null, description_pbi: null }],
};
const notFound = new ApiError(
  404,
  "not_found",
  "No dataset d1 that you may see.",
);

it("says a table the dataset does not hold is not there, and links back to the dataset", () => {
  const html = renderPage({
    dataset: model,
    fields: { measures: [], columns: [] },
    table: "Nope",
  });
  expect(html).toContain("No such table");
  expect(html).toContain(
    "There is no table called Nope in Sales model that you can see.",
  );
  expect(html).toContain("<a>Go to Sales model</a>");
});

it("answers a table the api will not show exactly like one the dataset does not hold", () => {
  const hidden = renderPage({ dataset: model, fields: notFound });
  const absent = renderPage({
    dataset: model,
    fields: { measures: [], columns: [] },
    table: "Sales ",
  });
  expect(hidden).toContain("No such table");
  expect(hidden.replace("Sales model", "")).toBe(
    absent.replace("Sales model", "").replace("Sales ", "Sales"),
  );
});

it("fails a dataset the reader may not see as the dataset page does, naming no table", () => {
  const html = renderPage({ dataset: notFound });
  expect(html).toContain("Something went wrong");
  expect(html).toContain("No dataset d1 that you may see.");
  expect(html).not.toContain("Sales");
});
