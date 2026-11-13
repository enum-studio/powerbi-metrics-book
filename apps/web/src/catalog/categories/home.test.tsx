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
import { MetricsHome } from "./home";

const state = vi.hoisted<{
  categories: "answers" | "never" | "fails";
  list: "answers" | "never" | "fails";
  notFiled: number | "never" | "fails";
  rows: string[];
}>(() => ({
  categories: "answers",
  list: "answers",
  notFiled: 2,
  rows: ["loose_metric"],
}));

const never = () =>
  new Promise(() => {
    // Stays loading.
  });

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

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  api: { GET: (path: string) => path },
  read: (path: string) => {
    if (path === "/api/v1/categories") {
      if (state.categories === "never") return never();
      return state.categories === "fails"
        ? Promise.reject(new Error("The categories could not be read."))
        : Promise.resolve([]);
    }
    if (path === "/api/v1/metrics") {
      if (state.list === "never") return never();
      return state.list === "fails"
        ? Promise.reject(new Error("The list could not be read."))
        : Promise.resolve({
            items: state.rows.map(item),
            next_cursor: "more",
          });
    }
    if (state.notFiled === "never") return never();
    if (state.notFiled === "fails")
      return Promise.reject(new Error("The summary could not be read."));
    return Promise.resolve({
      datasets: 1,
      metrics: { draft: state.notFiled, agent_verified: 0, human_verified: 0 },
      not_filed: state.notFiled,
    });
  },
}));

beforeEach(() => {
  state.categories = "answers";
  state.list = "answers";
  state.notFiled = 2;
  state.rows = ["loose_metric"];
});

/** Long enough for a failed request to be drawn, with retries off: TanStack notifies on a timer. */
const settled = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });

async function mount(notFiledOnly: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/catalog", "/catalog/metrics/$name"].map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => <MetricsHome notFiledOnly={notFiledOnly} />,
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
  return {
    host,
    client,
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}

it("draws the list of what is not filed while the book's counts are still on their way", async () => {
  state.notFiled = "never";
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("loose_metric");
    });
    expect(view.host.querySelector("h2")?.textContent.trim()).toBe("Not filed");
    expect(view.host.textContent).not.toContain(" of ");
  } finally {
    view.close();
  }
});

it("adds the count to the heading and the list once it arrives", async () => {
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.querySelector("h2")?.textContent).toBe("Not filed 2");
      expect(view.host.textContent).toContain("1 of 2");
    });
  } finally {
    view.close();
  }
});

it("shows no Not filed section when nothing is unfiled, even with the counts on their way", async () => {
  state.notFiled = "never";
  state.rows = [];
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.querySelector("h1")?.textContent).toBe("Metrics");
      expect(view.host.textContent).not.toContain("Loading");
    });
    expect(view.host.querySelector("h2")).toBeNull();
  } finally {
    view.close();
  }
});

it("draws the Not filed view while the count is on its way, and says what it holds", async () => {
  state.notFiled = "never";
  const view = await mount(true);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("loose_metric");
    });
    expect(view.host.querySelector("h1")?.textContent).toBe("Not filed");
    expect(view.host.textContent).toContain(
      "Metrics with no category yet. A curator or an agent can file them.",
    );
  } finally {
    view.close();
  }
});

it("says every metric has a category from an empty first page, with the count still on its way", async () => {
  state.notFiled = "never";
  state.rows = [];
  const view = await mount(true);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Every metric has a category.");
    });
    expect(view.host.textContent).not.toContain("with no category yet");
    expect(view.host.textContent).not.toContain("Show more");
  } finally {
    view.close();
  }
});

it("draws the Not filed view without waiting for the categories", async () => {
  state.categories = "never";
  const view = await mount(true);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("loose_metric");
    });
    expect(view.host.textContent).toContain("2 metrics with no category yet");
  } finally {
    view.close();
  }
});

it("keeps the lists when the count cannot be read", async () => {
  state.notFiled = "fails";
  for (const notFiledOnly of [false, true]) {
    const view = await mount(notFiledOnly);
    try {
      await vi.waitFor(() => {
        expect(view.host.textContent).toContain("loose_metric");
      });
      await settled();
      expect(view.host.textContent).toContain("loose_metric");
      expect(view.host.textContent).not.toContain("Something went wrong");
    } finally {
      view.close();
    }
  }
});

it("takes a count of zero beside rows for unknown", async () => {
  state.notFiled = 0;
  const home = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(home.host.querySelector("h2")?.textContent.trim()).toBe(
        "Not filed",
      );
    });
    expect(home.host.textContent).not.toContain("of 0");
  } finally {
    home.close();
  }
  const only = await mount(true);
  try {
    await vi.waitFor(() => {
      expect(only.host.textContent).toContain(
        "Metrics with no category yet. A curator or an agent can file them.",
      );
    });
    expect(only.host.textContent).not.toContain("of 0");
  } finally {
    only.close();
  }
});

it("takes a count above zero over an empty page, and claims nothing it cannot back", async () => {
  state.notFiled = 5;
  state.rows = [];
  const view = await mount(true);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("5 metrics with no category yet");
    });
    expect(view.host.textContent).not.toContain("Every metric has a category.");
  } finally {
    view.close();
  }
});

it("says it is loading, with no heading, until the first page arrives", async () => {
  state.list = "never";
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Loading the metrics");
    });
    expect(view.host.querySelector("h2")).toBeNull();
  } finally {
    view.close();
  }
});

it("says so when the first page cannot be read", async () => {
  state.list = "fails";
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Something went wrong");
    });
    expect(view.host.textContent).not.toContain("Not filed");
  } finally {
    view.close();
  }
});

it("keeps the lists when a later read of the categories fails", async () => {
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("loose_metric");
    });
    state.categories = "fails";
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["catalog", "categories"] });
    });
    expect(view.client.getQueryState(["catalog", "categories"])?.status).toBe(
      "error",
    );
    await settled();
    expect(view.host.textContent).toContain("loose_metric");
    expect(view.host.textContent).not.toContain("Something went wrong");
  } finally {
    view.close();
  }
});

it("says so when the categories cannot be read", async () => {
  state.categories = "fails";
  const view = await mount(false);
  try {
    await vi.waitFor(() => {
      expect(view.host.textContent).toContain("Something went wrong");
    });
  } finally {
    view.close();
  }
});
