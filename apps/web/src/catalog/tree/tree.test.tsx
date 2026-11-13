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
import { CatalogTree } from "./tree";

type Sent = {
  path: string;
  options?: {
    params?: { path?: { name?: string }; query?: { cursor?: string } };
  };
};

const state = vi.hoisted(() => ({
  sent: [] as { path: string; name?: string; query?: object }[],
  listFails: false,
  summaryFails: false,
  neverAnswers: "",
  noCategory: "",
  failing: "",
  categoriesFail: false,
  datasetsFail: false,
}));

const node = (
  path: string,
  name: string,
  metric_count: number,
  children: object[] = [],
) => ({
  kind: "category",
  id: path,
  key: path,
  path,
  name,
  description: null,
  position: 0,
  metric_count,
  children,
});

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  api: {
    GET: (path: string, options?: Sent["options"]) => ({ path, options }),
  },
  read: ({ path, options }: Sent) => {
    const name = options?.params?.path?.name;
    state.sent.push({
      path,
      ...(name === undefined ? {} : { name }),
      ...(options?.params?.query === undefined
        ? {}
        : { query: options.params.query }),
    });
    if (path === "/api/v1/categories" && state.categoriesFail)
      return Promise.reject(new Error("The categories could not be read."));
    if (path === "/api/v1/categories")
      return Promise.resolve([
        node("sales", "Sales", 2),
        node("metrics", "Metrics group", 0, [node("metrics/foo", "Foo", 0)]),
      ]);
    if (path === "/api/v1/book/summary")
      return state.summaryFails
        ? Promise.reject(new Error("The summary could not be read."))
        : Promise.resolve({
            datasets: 0,
            metrics: { draft: 3, agent_verified: 0, human_verified: 0 },
            not_filed: 1234,
          });
    if (path === "/api/v1/workspaces") return Promise.resolve([]);
    if (path === "/api/v1/datasets")
      return state.datasetsFail
        ? Promise.reject(new Error("The datasets could not be read."))
        : Promise.resolve({ items: [], next_cursor: null });
    if (path === "/api/v1/metrics")
      return state.listFails
        ? Promise.reject(new Error("The list could not be read."))
        : Promise.resolve(
            options?.params?.query?.cursor === undefined
              ? {
                  items: [
                    {
                      name: "net_sales",
                      label: "Net sales",
                      category: null,
                      dismissed: false,
                    },
                  ],
                  next_cursor: "more",
                }
              : {
                  items: [
                    {
                      name: "gross_sales",
                      label: "Gross sales",
                      category: null,
                      dismissed: false,
                    },
                  ],
                  next_cursor: null,
                },
          );
    if (name === state.neverAnswers)
      return new Promise(() => {
        // Stays loading.
      });
    if (name === state.failing)
      return Promise.reject(new Error("The metric could not be read."));
    return Promise.resolve({
      name,
      category: name === state.noCategory ? null : { path: "sales" },
    });
  },
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  state.sent = [];
  state.listFails = false;
  state.summaryFails = false;
  state.neverAnswers = "";
  state.noCategory = "";
  state.failing = "";
  state.categoriesFail = false;
  state.datasetsFail = false;
});

async function mount(at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      [
        "/catalog",
        "/catalog/categories/$",
        "/catalog/metrics/$name",
        "/catalog/terms",
      ].map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: CatalogTree,
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [at] }),
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
    expect(host.querySelector('nav, [role="alert"]')).not.toBeNull();
  });
  return {
    host,
    router,
    asked: (path: string) => state.sent.filter((each) => each.path === path),
    link: (text: string) => {
      const link = [...host.querySelectorAll("a")].find(
        (each) => each.textContent === text,
      );
      if (link === undefined) throw new Error(`Missing ${text}`);
      return link;
    },
    button: (text: string) => {
      const button = [...host.querySelectorAll("button")].find((each) =>
        each.textContent.startsWith(text),
      );
      if (button === undefined) throw new Error(`Missing ${text}`);
      return button;
    },
    arrow: (name: string) => {
      const button = [...host.querySelectorAll("button")].find(
        (each) => each.getAttribute("aria-label") === name,
      );
      if (button === undefined) throw new Error(`Missing ${name}`);
      return button;
    },
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}

it("shows counts without asking for any metric, and asks for a category's only once it is open", async () => {
  const view = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("1,234");
    });
    expect(view.asked("/api/v1/metrics")).toEqual([]);
    expect(view.host.textContent).not.toContain("Net sales");
    await act(async () => {
      view.arrow("Open Sales").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Net sales");
    });
    expect(view.asked("/api/v1/metrics")).toEqual([
      {
        path: "/api/v1/metrics",
        query: { limit: "50", category: "sales" },
      },
    ]);
    // More than the first page goes on in the tree, a page at a time.
    await act(async () => {
      view.button("Show more").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Gross sales");
    });
    expect(view.asked("/api/v1/metrics").at(-1)?.query).toEqual({
      limit: "50",
      category: "sales",
      cursor: "more",
    });
    expect(view.host.textContent).not.toContain("Show more");
  } finally {
    view.close();
  }
});

it("links to the view of what is not filed, with its count", async () => {
  const view = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      const link = [...view.host.querySelectorAll("a")].find((each) =>
        each.textContent.startsWith("Not filed"),
      );
      expect(link?.getAttribute("href")).toBe("/catalog?view=not-filed");
      expect(link?.textContent).toContain("1,234");
    });
  } finally {
    view.close();
  }
});

it("says so when a category's list or the summary cannot be read", async () => {
  state.listFails = true;
  const open = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      expect(open.arrow("Open Sales")).toBeDefined();
    });
    await act(async () => {
      open.arrow("Open Sales").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(open.host.textContent).toContain("Something went wrong");
    });
  } finally {
    open.close();
  }
  state.summaryFails = true;
  const summary = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      expect(summary.host.textContent).toContain("Something went wrong");
    });
    // A count is not worth the navigation.
    expect(summary.host.textContent).toContain("Sales");
  } finally {
    summary.close();
  }
});

it("takes a category whose key is metrics for a category, and asks for no metric", async () => {
  const view = await mount("/catalog/categories/metrics/foo");
  try {
    await vi.waitFor(() => {
      expect(view.arrow("Close Metrics group")).toBeDefined();
    });
    expect(view.asked("/api/v1/metrics/{name}")).toEqual([]);
  } finally {
    view.close();
  }
});

it("marks Not filed on a metric with no category, which has no row of its own", async () => {
  state.noCategory = "loose";
  const view = await mount("/catalog/metrics/loose");
  try {
    await vi.waitFor(() => {
      const link = [...view.host.querySelectorAll("a")].find((each) =>
        each.textContent.startsWith("Not filed"),
      );
      expect(link?.getAttribute("data-status")).toBe("active");
    });
  } finally {
    view.close();
  }
});

it("marks the category of a metric past the pages loaded, and the metric's own row once it shows", async () => {
  const view = await mount("/catalog/metrics/gross_sales");
  try {
    await vi.waitFor(() => {
      expect(view.link("Sales").getAttribute("data-status")).toBe("active");
    });
    await act(async () => {
      view.button("Show more").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(view.link("Gross sales").getAttribute("data-status")).toBe(
        "active",
      );
    });
    expect(view.link("Sales").getAttribute("data-status")).toBeNull();
  } finally {
    view.close();
  }
});

it("marks a category folded on the way to the metric, and Metrics when it is folded itself", async () => {
  const view = await mount("/catalog/metrics/net_sales");
  try {
    await vi.waitFor(() => {
      expect(view.link("Net sales").getAttribute("data-status")).toBe("active");
    });
    expect(view.link("Sales").getAttribute("data-status")).toBeNull();
    await act(async () => {
      view.arrow("Close Sales").click();
      await Promise.resolve();
    });
    expect(view.link("Sales").getAttribute("data-status")).toBe("active");
    await act(async () => {
      view.arrow("Close Metrics").click();
      await Promise.resolve();
    });
    expect(view.link("Metrics").getAttribute("data-status")).toBe("active");
  } finally {
    view.close();
  }
});

it("asks for the datasets only once they are unfolded, and their failure leaves the rest", async () => {
  state.datasetsFail = true;
  const view = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Sales");
    });
    expect(view.asked("/api/v1/datasets")).toEqual([]);
    expect(view.asked("/api/v1/workspaces")).toEqual([]);
    await act(async () => {
      view.button("Datasets").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Something went wrong");
    });
    expect(view.link("Sales")).toBeDefined();
    expect(view.link("Terms")).toBeDefined();
  } finally {
    view.close();
  }
});

it("keeps Terms and Datasets when the categories fail", async () => {
  state.categoriesFail = true;
  const view = await mount("/catalog");
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Something went wrong");
    });
    expect(view.link("Terms")).toBeDefined();
    expect(view.button("Datasets")).toBeDefined();
  } finally {
    view.close();
  }
});

const toMetric = (view: Awaited<ReturnType<typeof mount>>, name: string) =>
  act(async () => {
    await view.router.navigate({
      to: "/catalog/metrics/$name",
      params: { name },
    });
  });

it("closes the path for a metric with no category and for one that cannot be read, and keeps the tree", async () => {
  state.noCategory = "loose";
  state.failing = "broken";
  for (const name of ["loose", "broken"]) {
    const view = await mount("/catalog/metrics/first");
    try {
      await vi.waitFor(() => {
        expect(view.arrow("Close Sales")).toBeDefined();
      });
      await toMetric(view, name);
      await vi.waitFor(() => {
        expect(view.arrow("Open Sales")).toBeDefined();
      });
      expect(view.host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      view.close();
    }
  }
});

it("follows a category page at once, even while a metric is still loading", async () => {
  state.neverAnswers = "second";
  const view = await mount("/catalog/metrics/first");
  try {
    await vi.waitFor(() => {
      expect(view.arrow("Close Sales")).toBeDefined();
    });
    await toMetric(view, "second");
    await act(async () => {
      await view.router.navigate({
        to: "/catalog/categories/$",
        params: { _splat: "metrics/foo" },
      });
    });
    await vi.waitFor(() => {
      expect(view.arrow("Close Metrics group")).toBeDefined();
    });
    expect(view.arrow("Open Sales")).toBeDefined();
  } finally {
    view.close();
  }
});

it("leaves a category a person closed closed while the next metric loads", async () => {
  state.neverAnswers = "second";
  const view = await mount("/catalog/metrics/first");
  try {
    await vi.waitFor(() => {
      expect(view.arrow("Close Sales")).toBeDefined();
    });
    await act(async () => {
      view.arrow("Close Sales").click();
      await Promise.resolve();
    });
    expect(view.arrow("Open Sales")).toBeDefined();
    await toMetric(view, "second");
    await vi.waitFor(() => {
      expect(
        view.asked("/api/v1/metrics/{name}").map((each) => each.name),
      ).toContain("second");
    });
    expect(view.arrow("Open Sales")).toBeDefined();
  } finally {
    view.close();
  }
});

it("keeps the path open while the next metric loads", async () => {
  const view = await mount("/catalog/metrics/first");
  try {
    await vi.waitFor(() => {
      expect(view.arrow("Close Sales")).toBeDefined();
    });
    state.neverAnswers = "second";
    await act(async () => {
      await view.router.navigate({
        to: "/catalog/metrics/$name",
        params: { name: "second" },
      });
    });
    await vi.waitFor(() => {
      expect(
        view.asked("/api/v1/metrics/{name}").map((each) => each.name),
      ).toContain("second");
    });
    expect(view.arrow("Close Sales")).toBeDefined();
  } finally {
    view.close();
  }
});
