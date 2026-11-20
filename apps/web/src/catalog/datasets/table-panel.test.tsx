// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "../../access/api";
import { meQuery, type Me } from "../../api/me";
import { configWith } from "../../shell/brand-test-support";
import type { DiagramModel, DiagramTable } from "../diagram/model";
import { TablePanel } from "./table-panel";

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  api: { GET: (path: string) => path },
  read: (path: string) =>
    Promise.resolve(
      path === "/api/v1/me" ? null : { items: [], next_cursor: null },
    ),
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params: Record<string, string>;
  }) => (
    <a
      href={Object.entries(params).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

const sales: DiagramTable = {
  name: "Sales",
  description: null,
  columns: [
    { name: "Amount", type: "Decimal", hidden: false },
    { name: "Date", type: "DateTime", hidden: false },
  ],
  measures: [{ name: "Net sales", folder: null }],
};

let scrolled: string[] = [];
beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent);
  };
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

function mount(demo = false, admin = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(signInConfigQuery.queryKey, {
    ...configWith({
      name: "Metrics",
      company: null,
      logo_url: null,
      custom: false,
    }),
    demo,
  });
  if (admin) client.setQueryData(meQuery.queryKey, { may_admin: true } as Me);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { host, root };
  const show = (field: string | undefined, table: DiagramTable = sales) => {
    // A new model each time, as a refetch of the dataset gives.
    const model: DiagramModel = {
      tables: [table],
      relationships: [],
      unknown: null,
    };
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <TablePanel
            datasetId="d1"
            table={table}
            field={field}
            model={model}
            onClose={() => undefined}
            onRelationship={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
  };
  return { host, show };
}

it("brings the field a link asked for into view once, not again as the panel redraws", () => {
  const view = mount();
  view.show("Date");
  expect(
    view.host.querySelector('[aria-current="true"]')?.textContent,
  ).toContain("Date");
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toContain("Date");
  // A PII change refetches the dataset: the same table and field, drawn again.
  view.show("Date", { ...sales, columns: [...sales.columns] });
  view.show("Date", { ...sales, columns: [...sales.columns] });
  expect(scrolled).toHaveLength(1);
});

it("brings the next field into view when a link asks for another", () => {
  const view = mount();
  view.show("Date");
  view.show("Net sales");
  expect(scrolled).toHaveLength(2);
  expect(scrolled[1]).toContain("Net sales");
  view.show(undefined);
  expect(scrolled).toHaveLength(2);
  expect(view.host.querySelector('[aria-current="true"]')).toBeNull();
});

it("offers Mark PII to an admin, and not in the demo", () => {
  const open = mount(false, true);
  open.show(undefined);
  expect(open.host.textContent).toContain("Mark PII");
  const demo = mount(true, true);
  demo.show(undefined);
  expect(demo.host.textContent).not.toContain("Mark PII");
});

it("links the table's name and each column to their pages", () => {
  const view = mount();
  view.show(undefined);
  const hrefs = [...view.host.querySelectorAll("a")].map((a) =>
    a.getAttribute("href"),
  );
  expect(hrefs).toEqual([
    "/catalog/datasets/d1/tables/Sales",
    "/catalog/datasets/d1/tables/Sales/columns/Amount",
    "/catalog/datasets/d1/tables/Sales/columns/Date",
  ]);
});
