// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { DiagramTable } from "../diagram/model";
import { TableTree } from "./table-tree";

const tables: DiagramTable[] = [
  {
    name: "Sales",
    description: null,
    columns: [
      { name: "Amount", type: "Decimal", hidden: false },
      { name: "Order date", type: "DateTime", hidden: false },
    ],
    measures: [
      { name: "Net sales", folder: null, format: "#,0.00" },
      { name: "Margin %", folder: "Ratios", format: "0.0%" },
      { name: "Orders", folder: null, format: null },
    ],
  },
  {
    name: "Date",
    description: "One row a day.",
    columns: [{ name: "Date", type: "DateTime", hidden: false }],
    measures: [],
  },
];

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let mounted: { host: HTMLElement; root: Root } | undefined;
afterEach(() => {
  if (mounted === undefined) return;
  const { host, root } = mounted;
  act(() => {
    root.unmount();
  });
  host.remove();
  mounted = undefined;
});

async function mount(measuresOnly: boolean) {
  const rootRoute = createRootRoute({
    component: () => (
      <TableTree
        datasetId="d1"
        tables={tables}
        table="Sales"
        field={undefined}
        measuresOnly={measuresOnly}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/catalog/datasets/$id",
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/catalog/datasets/$id/tables/$table",
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/catalog/datasets/$id/tables/$table/columns/$column",
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/catalog/datasets/d1"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { host, root };
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  const row = (name: string) =>
    [...host.querySelectorAll("a")].find(
      (a) => a.querySelector("span")?.textContent === name,
    )?.textContent;
  const tableRow = (name: string) =>
    host.querySelector(`a[href$="/tables/${name}"]`)?.parentElement
      ?.textContent;
  return { host, row, tableRow };
}

it("counts a table's columns and measures apart, and ends each field's row with its format or type", async () => {
  const view = await mount(false);
  expect(view.tableRow("Sales")).toBe("Sales2 columns, 3 measures");
  expect(view.tableRow("Date")).toBe("Date1 column, 0 measures");
  // Sales is the table in the address, so it is open.
  expect(view.row("Net sales")).toBe("Net sales, #,0.00");
  expect(view.row("Orders")).toBe("Orders");
  expect(view.row("Amount")).toBe("Amount, Decimal");
});

it("sends a table to its page, a column to its page and a measure to its table's Measures tab, never the diagram", async () => {
  const { host } = await mount(false);
  const href = (name: string) =>
    host.querySelector(`a[title="${name}"]`)?.getAttribute("href");
  expect(href("Date")).toBe("/catalog/datasets/d1/tables/Date");
  expect(href("Amount")).toBe(
    "/catalog/datasets/d1/tables/Sales/columns/Amount",
  );
  expect(href("Net sales")).toBe(
    "/catalog/datasets/d1/tables/Sales?tab=measures&field=Net+sales",
  );
  expect(host.innerHTML).not.toContain("tab=diagram");
});

it("on the measures tab, counts only measures and lists no columns", async () => {
  const view = await mount(true);
  expect(view.tableRow("Sales")).toBe("Sales3 measures");
  expect(view.tableRow("Date")).toBeUndefined();
  expect(view.row("Net sales")).toBe("Net sales, #,0.00");
  expect(view.row("Amount")).toBeUndefined();
});
