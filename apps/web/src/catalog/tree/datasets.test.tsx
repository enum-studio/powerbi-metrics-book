// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatasetsBranch } from "./datasets";

type Sent = {
  path: string;
  options?: {
    params?: { path?: { id?: string }; query?: { table?: string } };
  };
};

const state = vi.hoisted(() => ({
  sent: [] as { path: string; id?: string; query?: object }[],
}));

const workspace = (id: string, name: string) => ({
  kind: "workspace",
  id,
  name,
});
const dataset = (id: string, name: string, workspaceId: string) => ({
  kind: "dataset",
  id,
  name,
  workspace: { kind: "workspace", id: workspaceId, name: "" },
});
const table = (name: string, measure_count: number, column_count: number) => ({
  kind: "table",
  id: name,
  name,
  is_hidden: false,
  description: null,
  description_pbi: null,
  column_count,
  measure_count,
  custom: {},
});

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  api: {
    GET: (path: string, options?: Sent["options"]) => ({ path, options }),
  },
  read: ({ path, options }: Sent) => {
    const id = options?.params?.path?.id;
    state.sent.push({
      path,
      ...(id === undefined ? {} : { id }),
      ...(options?.params?.query === undefined
        ? {}
        : { query: options.params.query }),
    });
    if (path === "/api/v1/workspaces")
      return Promise.resolve([
        workspace("w1", "Sales workspace"),
        workspace("w2", "Finance workspace"),
      ]);
    if (path === "/api/v1/datasets")
      return Promise.resolve({
        items: [
          dataset("d1", "Retail", "w1"),
          dataset("d2", "Web shop", "w1"),
          dataset("d3", "Ledger", "w2"),
        ],
        next_cursor: null,
      });
    if (path === "/api/v1/datasets/{id}")
      return Promise.resolve({
        id,
        name: "Retail",
        tables: [table("Sales", 3, 2), table("Customer", 0, 1)],
      });
    const ofSales = options?.params?.query?.table === "Sales";
    if (path === "/api/v1/datasets/{id}/measures")
      return Promise.resolve({
        items: !ofSales
          ? []
          : [
              { name: "Net sales", display_folder: "Revenue" },
              { name: "Margin", display_folder: "Revenue\\Margin" },
              { name: "Orders", display_folder: null },
            ],
        next_cursor: null,
      });
    if (path === "/api/v1/datasets/{id}/columns")
      return Promise.resolve({
        items: ofSales
          ? [
              { name: "Amount", data_type: "double", is_hidden: false },
              { name: "Date", data_type: "dateTime", is_hidden: false },
            ]
          : [{ name: "Customer key", data_type: "int64", is_hidden: true }],
        next_cursor: null,
      });
    return Promise.reject(new Error(`Nothing mocked for ${path}`));
  },
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  state.sent = [];
});

let close = () => {
  // Nothing mounted yet.
};
afterEach(() => {
  close();
});

async function mount(at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // As in the shell: the tree stays while the page beside it changes.
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <nav aria-label="Catalog">
          <DatasetsBranch />
        </nav>
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      [
        "/catalog/terms",
        "/catalog/datasets/$id",
        "/catalog/datasets/$id/tables/$table",
      ].map((path) => createRoute({ getParentRoute: () => rootRoute, path })),
    ),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  close = () => {
    act(() => {
      root.unmount();
    });
    host.remove();
    client.clear();
  };
  const find = (selector: string, text: string) =>
    [...host.querySelectorAll<HTMLElement>(selector)].find((each) =>
      (each.getAttribute("aria-label") ?? each.textContent).startsWith(text),
    );
  const shown = (text: string) => find("a, button", text) !== undefined;
  const click = async (text: string) => {
    await vi.waitFor(() => {
      expect(find("button", text)).toBeDefined();
    });
    await act(async () => {
      find("button", text)?.click();
      await Promise.resolve();
    });
  };
  return {
    router,
    shown,
    click,
    find,
    asked: (path: string) => state.sent.filter((each) => each.path === path),
    until: (check: () => void) => vi.waitFor(check),
  };
}

it("asks for a dataset's tables only once it is opened, and a table's fields only once the table is", async () => {
  const view = await mount("/catalog/terms");
  expect(view.asked("/api/v1/datasets")).toEqual([]);
  await view.click("Datasets");
  await view.until(() => {
    expect(view.shown("Sales workspace")).toBe(true);
  });
  // A workspace with one dataset still has its row, with its count.
  expect(view.find("button", "Finance workspace")?.textContent).toBe(
    "Finance workspace1",
  );
  expect(view.find("button", "Sales workspace")?.textContent).toBe(
    "Sales workspace2",
  );
  expect(view.shown("Retail")).toBe(false);
  await view.click("Sales workspace");
  expect(view.shown("Retail")).toBe(true);
  expect(view.asked("/api/v1/datasets/{id}")).toEqual([]);
  // A dataset's count of tables comes with its tables, so it shows once it is opened, and stays.
  const retailRow = () => view.find("a", "Retail")?.parentElement?.textContent;
  expect(retailRow()).toBe("Retail");
  await view.click("Open Retail");
  await view.until(() => {
    expect(view.shown("Customer")).toBe(true);
  });
  expect(retailRow()).toBe("Retail2");
  expect(view.asked("/api/v1/datasets/{id}")).toEqual([
    { path: "/api/v1/datasets/{id}", id: "d1" },
  ]);
  // A table's count is its measures and its columns.
  expect(view.find("a", "Sales")?.parentElement?.textContent).toBe("Sales5");
  expect(view.asked("/api/v1/datasets/{id}/measures")).toEqual([]);
  await view.click("Open Sales");
  await view.until(() => {
    expect(view.shown("Orders")).toBe(true);
  });
  expect(view.asked("/api/v1/datasets/{id}/measures")).toEqual([
    {
      path: "/api/v1/datasets/{id}/measures",
      id: "d1",
      query: { table: "Sales", limit: 500 },
    },
  ]);
  expect(view.asked("/api/v1/datasets/{id}/columns")).toHaveLength(1);
  await view.click("Close Retail");
  expect(retailRow()).toBe("Retail2");
  expect(view.asked("/api/v1/datasets/{id}")).toHaveLength(1);
});

it("folds a table's measures by display folder, folders first, then the measures in none, then the columns", async () => {
  const view = await mount("/catalog/datasets/d1");
  await view.click("Open Sales");
  await view.until(() => {
    expect(view.shown("Orders")).toBe(true);
  });
  // The rows after a given one, as a reader meets them going down the tree.
  const rows = (from: string) => {
    const all = [
      ...document.querySelectorAll<HTMLElement>("a, button[aria-expanded]"),
    ]
      .map((each) => each.textContent)
      .filter(Boolean);
    return all.slice(all.indexOf(from) + 1);
  };
  expect(rows("Sales").slice(0, 4)).toEqual([
    "Revenue",
    "Orders",
    "Amount",
    "Date",
  ]);
  expect(view.shown("Net sales")).toBe(false);
  await view.click("Open Revenue");
  expect(view.shown("Net sales")).toBe(true);
  expect(view.shown("Margin")).toBe(true);
  // Margin the folder holds Margin the measure, and stays folded until opened.
  expect(
    view.find("button", "Open Margin")?.getAttribute("aria-expanded"),
  ).toBe("false");
});

it("opens only the way to the field on screen, and marks the field", async () => {
  const view = await mount(
    "/catalog/datasets/d1?tab=diagram&table=Sales&field=Margin",
  );
  await view.until(() => {
    expect(view.find("a", "Margin")).toBeDefined();
  });
  expect(
    document.querySelector('a[data-status="active"][title="Margin"]'),
  ).not.toBeNull();
  expect(
    view.find("button", "Close Revenue")?.getAttribute("aria-expanded"),
  ).toBe("true");
  // The other workspace and the other table stay folded.
  expect(view.shown("Ledger")).toBe(false);
  expect(view.find("button", "Open Customer")).toBeDefined();
  expect(view.asked("/api/v1/datasets/{id}/measures")).toHaveLength(1);
});

it("holds what a person closes and opens as they move, and opens the way to the next page again", async () => {
  const view = await mount("/catalog/datasets/d1");
  await view.until(() => {
    expect(view.shown("Open Sales")).toBe(true);
  });
  await view.click("Finance workspace");
  expect(view.shown("Ledger")).toBe(true);
  await view.click("Sales workspace");
  expect(view.shown("Retail")).toBe(false);
  await act(async () => {
    await view.router.navigate({ to: "/catalog/terms" });
  });
  expect(view.shown("Ledger")).toBe(true);
  expect(view.shown("Retail")).toBe(false);
  await act(async () => {
    await view.router.navigate({ href: "/catalog/datasets/d1" });
  });
  await view.until(() => {
    expect(view.shown("Retail")).toBe(true);
  });
  expect(view.shown("Ledger")).toBe(true);
});

it("reads the table from the route's params, so a malformed escape in the address does not throw", async () => {
  const view = await mount("/catalog/datasets/d1/tables/%E0%A4");
  await vi.waitFor(() => {
    expect(view.shown("Sales workspace")).toBe(true);
  });
  expect(view.router.state.location.pathname).toContain("tables/");
});
