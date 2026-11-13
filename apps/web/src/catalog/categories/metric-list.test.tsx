// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { MetricList } from "./metric-list";

const state = vi.hoisted(() => ({
  asked: [] as Record<string, string | undefined>[],
  fails: false,
}));

const item = (name: string) => ({
  kind: "metric",
  id: name,
  name,
  label: name,
  category: null,
  summary: "",
  aliases: [],
  unit: null,
  dataset_count: 1,
  trust_state: "draft",
  origin: "drafter",
  custom: {},
  dismissed: false,
});

vi.mock("../../api/client", () => ({
  api: {
    GET: (_path: string, options: { params: { query: object } }) =>
      options.params.query,
  },
  read: (query: Record<string, string | undefined>) => {
    state.asked.push(query);
    if (state.fails && query.cursor !== undefined)
      return Promise.reject(new Error("No."));
    return Promise.resolve(
      query.cursor === undefined
        ? { items: [item("first")], next_cursor: "next" }
        : { items: [item("second")], next_cursor: null },
    );
  },
}));

beforeEach(() => {
  state.asked = [];
  state.fails = false;
});

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/catalog/metrics/$name"].map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => (
            <MetricList filter={{ not_filed: "true" }} total={1200} />
          ),
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(host.textContent).toContain("first");
  });
  return {
    host,
    showMore: async () => {
      const button = [...host.querySelectorAll("button")].find(
        (each) => each.textContent === "Show more",
      );
      if (button === undefined) throw new Error("Missing Show more");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    },
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}

it("asks for one page, says how much there is, and asks for the next only on Show more", async () => {
  const view = await mount();
  try {
    expect(state.asked).toEqual([{ limit: "50", not_filed: "true" }]);
    expect(view.host.textContent).toContain("1 of 1,200");
    await view.showMore();
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("second");
    });
    expect(state.asked).toEqual([
      { limit: "50", not_filed: "true" },
      { limit: "50", not_filed: "true", cursor: "next" },
    ]);
    expect(view.host.textContent).toContain("first");
    expect(view.host.textContent).not.toContain("Show more");
  } finally {
    view.close();
  }
});

it("keeps what it has and offers the button again when the next page fails", async () => {
  state.fails = true;
  const view = await mount();
  try {
    await view.showMore();
    await vi.waitFor(() => {
      expect(view.host.querySelector('[role="alert"]')?.textContent).toBe(
        "The next metrics could not be loaded. Show more tries again.",
      );
    });
    expect(view.host.textContent).toContain("first");
    expect(view.host.textContent).toContain("Show more");
  } finally {
    view.close();
  }
});
