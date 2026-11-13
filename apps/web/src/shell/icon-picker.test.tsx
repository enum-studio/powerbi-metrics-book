// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Table2 } from "lucide-react";
import { beforeEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "../access/api";
import { configWith } from "./brand-test-support";
import { IconPicker, loadEmoji, offered, PageIcon } from "./icon-picker";

const state = vi.hoisted(() => ({
  sent: [] as {
    method: string;
    path: string;
    body?: unknown;
    params?: unknown;
  }[],
  refusal: null as string | null,
  roles: ["curator"] as string[],
}));

vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  api: {
    GET: (path: string) => ({ method: "GET", path }),
    PUT: (path: string, options: { body: unknown; params: unknown }) => ({
      method: "PUT",
      path,
      body: options.body,
      params: options.params,
    }),
    DELETE: (path: string) => ({ method: "DELETE", path }),
  },
  read: (call: { method: string; path: string; body?: unknown }) => {
    state.sent.push(call);
    if (call.method === "PUT" && state.refusal !== null)
      return Promise.reject(new Error(state.refusal));
    if (call.path === "/api/v1/me")
      return Promise.resolve({ roles: state.roles, may_admin: false });
    if (call.path === "/api/v1/icons")
      return Promise.resolve({
        glyphs: ["chart-line", "chart-bar", "store"],
        colors: ["gray", "green", "blue"],
      });
    return Promise.resolve({ icon: null });
  },
}));

beforeEach(() => {
  state.sent = [];
  state.refusal = null;
  state.roles = ["curator"];
  document.body.innerHTML = "";
});

const shown = (selector: string) =>
  vi.waitFor(() => {
    expect(find(selector)).not.toBeNull();
  });
const press = (element: Element) => {
  act(() => {
    (element as HTMLElement).click();
  });
};
const find = (selector: string) => document.body.querySelector(selector);

/** Renders the node and waits until no query is in flight and the answers are drawn. */
async function mount(node: React.ReactNode, demo = false) {
  const host = document.body.appendChild(document.createElement("div"));
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
  act(() => {
    createRoot(host).render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(client.isFetching()).toBe(0);
  });
  await act(() => Promise.resolve());
}

it("chooses a glyph in the picked colour, from the Icons tab", async () => {
  const chosen: (string | null)[] = [];
  await mount(
    <IconPicker
      value="glyph:store:gray"
      onChange={(icon) => chosen.push(icon)}
      onClose={() => undefined}
    />,
  );
  press(find('[aria-label="green"]') as Element);
  press(find('[aria-label="chart-line"]') as Element);
  expect(chosen).toEqual(["glyph:chart-line:green"]);
});

it("narrows the glyphs by the search field", async () => {
  await mount(
    <IconPicker
      value="glyph:store:gray"
      onChange={() => undefined}
      onClose={() => undefined}
    />,
  );
  const search = find('[aria-label="Search icons"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(search, "chart");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect([
    ...document.body.querySelectorAll('[aria-label^="chart"]'),
  ]).toHaveLength(2);
  expect(find('[aria-label="store"]')).toBeNull();
});

it("loads the emoji when the Emoji tab opens and chooses one", async () => {
  const chosen: (string | null)[] = [];
  await mount(
    <IconPicker
      value={null}
      onChange={(icon) => chosen.push(icon)}
      onClose={() => undefined}
    />,
  );
  await vi.waitFor(() => {
    expect(find('[aria-label="grinning face"]')).not.toBeNull();
  });
  press(find('[aria-label="grinning face"]') as Element);
  expect(chosen).toEqual(["emoji:\u{1F600}"]);
});

it("moves with the arrows, resets and closes on Escape", async () => {
  const chosen: (string | null)[] = [];
  let closed = 0;
  await mount(
    <IconPicker
      value="glyph:store:gray"
      onChange={(icon) => chosen.push(icon)}
      onClose={() => closed++}
    />,
  );
  const first = find('[aria-label="chart-line"]') as HTMLElement;
  first.focus();
  act(() => {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("chart-bar");
  press(
    [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "Reset",
    ) as Element,
  );
  expect(chosen).toEqual([null]);
  act(() => {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(closed).toBe(1);
});

it("sends the choice for the element and offers the button to a curator only", async () => {
  await mount(
    <PageIcon kind="metric" id="m-1" icon={null} fallback={Table2} />,
  );
  press(find('[aria-label="Change the icon"]') as Element);
  await shown('[role="tab"]:not([aria-selected="true"])');
  press(find('[role="tab"]:not([aria-selected="true"])') as Element);
  await shown('[aria-label="store"]');
  press(find('[aria-label="store"]') as Element);
  await vi.waitFor(() => {
    expect(state.sent.some((call) => call.method === "PUT")).toBe(true);
  });
  expect(state.sent.find((call) => call.method === "PUT")).toEqual({
    method: "PUT",
    path: "/api/v1/elements/{kind}/{id}/icon",
    params: { path: { kind: "metric", id: "m-1" } },
    body: { icon: "glyph:store:gray" },
  });

  document.body.innerHTML = "";
  state.roles = ["viewer"];
  await mount(
    <PageIcon kind="metric" id="m-1" icon={null} fallback={Table2} />,
  );
  expect(find("button")).toBeNull();
  expect(find("svg")).toBeNull();
});

it("offers only emoji the api takes", async () => {
  const groups = await loadEmoji();
  const all = groups.flatMap(({ items }) => items.map((e) => e.unicode));
  expect(all.length).toBeGreaterThan(1000);
  expect(all.filter((emoji) => !offered(emoji))).toEqual([]);
  expect(groups.map(({ title }) => title)).not.toContain("components");
  expect(all).not.toContain("1\uFE0F\u20E3");
  expect(all).toContain("\u{1F1E9}\u{1F1F0}");
  // The list writes the money bag with a selector it does not need; it is offered without it.
  expect(all).toContain("\u{1F4B0}");
});

it.each(["refused", "not_found"])(
  "shows the api's %s answer as text and keeps the picker open",
  async (kind) => {
    state.refusal = `The api said ${kind} <b>now</b>.`;
    await mount(
      <PageIcon kind="metric" id="m-1" icon={null} fallback={Table2} />,
    );
    press(find('[aria-label="Change the icon"]') as Element);
    await shown('[role="tab"]:not([aria-selected="true"])');
    press(find('[role="tab"]:not([aria-selected="true"])') as Element);
    await shown('[aria-label="store"]');
    press(find('[aria-label="store"]') as Element);
    await vi.waitFor(() => {
      expect(find('[role="alert"]')?.textContent).toBe(state.refusal);
    });
    expect(find('[role="alert"] b')).toBeNull();
    expect(find('[role="dialog"]')).not.toBeNull();
  },
);

it("offers no icon button in the demo, even to a curator", async () => {
  await mount(
    <PageIcon kind="metric" id="m-1" icon={null} fallback={Table2} />,
    true,
  );
  expect(find('[aria-label="Change the icon"]')).toBeNull();
});
