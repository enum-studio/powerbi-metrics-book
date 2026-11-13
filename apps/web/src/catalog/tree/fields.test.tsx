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
import { FieldRows, FIELDS_SHOWN, type TableFields } from "./fields";

const COLUMNS = 150;
const fields: TableFields = {
  measures: [],
  columns: Array.from({ length: COLUMNS }, (_, i) => ({
    name: `Column ${String(i + 1)}`,
    type: "Int64",
    hidden: false,
  })),
};

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

async function mount(current: string | undefined) {
  const rootRoute = createRootRoute({
    component: () => (
      <FieldRows
        datasetId="d1"
        table="Sales"
        fields={fields}
        depth={1}
        current={current}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/catalog/datasets/$id",
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
  const rows = () => [...host.querySelectorAll("a")].map((a) => a.textContent);
  const more = () =>
    [...host.querySelectorAll("button")].find((b) =>
      b.textContent.startsWith("Show more"),
    );
  return { host, rows, more };
}

it("shows the first rows of a long table and the rest on Show more", async () => {
  const view = await mount(undefined);
  expect(view.rows()).toHaveLength(FIELDS_SHOWN);
  expect(view.rows().at(-1)).toBe(`Column ${String(FIELDS_SHOWN)}`);
  expect(view.more()?.textContent).toBe(
    `Show more${String(COLUMNS - FIELDS_SHOWN)}`,
  );
  act(() => {
    view.more()?.click();
  });
  expect(view.rows()).toHaveLength(COLUMNS);
  expect(view.more()).toBeUndefined();
});

it("draws and marks the field on screen even past the first rows", async () => {
  const view = await mount("Column 140");
  expect(view.rows()).toHaveLength(FIELDS_SHOWN + 1);
  expect(view.rows().at(-1)).toBe("Column 140");
  const marked = view.host.querySelector('a[data-status="active"]');
  expect(marked?.textContent).toBe("Column 140");
  expect(view.more()?.textContent).toBe(
    `Show more${String(COLUMNS - FIELDS_SHOWN - 1)}`,
  );
  // Showing the rest puts it back in its place, once.
  act(() => {
    view.more()?.click();
  });
  expect(view.rows()).toHaveLength(COLUMNS);
  expect(view.rows()[139]).toBe("Column 140");
});
