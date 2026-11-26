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
import { expect, it, vi } from "vitest";
import { type Grant, grantsQuery, signInConfigQuery } from "../access/api";
import { peopleQuery } from "../admin/access/api";
import { settingQuery, statusQuery } from "../admin/settings/api";
import type { Me } from "../api/me";
import { bookSummaryQuery } from "../catalog/queries";
import type { operations } from "../api/schema";
import { AGENT } from "../setup/screen-test-support";
import type { SearchAnswer, SearchHit } from "../catalog/search/model";
import { searchQuery } from "../catalog/search/queries";
import { configWith } from "../shell/brand-test-support";
import { Home } from "./home";

window.matchMedia = (query) =>
  ({ matches: false, media: query }) as MediaQueryList;
const askedForGrants = vi.hoisted(() => vi.fn());
vi.mock("../access/api", async (original) => {
  const actual = await original<typeof import("../access/api")>();
  return {
    ...actual,
    grantsQuery: { ...actual.grantsQuery, queryFn: askedForGrants },
  };
});

const VIEWER: Me = {
  id: "me",
  kind: "person",
  email: "viewer@sample.example",
  name: "Viewer",
  roles: ["viewer"],
  sign_in_method: "microsoft",
  via: "browser",
  powerbi_connection: "connected",
  powerbi_connect_url: "/api/v1/powerbi/connect",
  sample_data: true,
  questions: true,
  usage: { capture: true, retention_days: 180 },
  may_admin: false,
  warnings: [],
  client_address: null,
};
const SUMMARY = {
  datasets: 5,
  metrics: { draft: 38, agent_verified: 2, human_verified: 1 },
  not_filed: 38,
};
const EMPTY = {
  datasets: 0,
  metrics: { draft: 0, agent_verified: 0, human_verified: 0 },
  not_filed: 0,
};
type Ok<Name extends keyof operations> = operations[Name] extends {
  responses: { 200: { content: { "application/json": infer Body } } };
}
  ? Body
  : never;
type Status = Ok<"getApiV1AdminStatus">;
type People = Ok<"getApiV1AdminPeople">["people"];
const PERSON: People[number] = {
  id: "person",
  name: "Someone",
  email: "someone@sample.example",
  title: "",
  sign_in_method: "microsoft",
  last_seen_at: null,
  powerbi_connection: "connected",
  grants: [],
  roles: [],
  status: "active",
  deactivated_at: null,
  direct_role: null,
  pii_reader: { source: "none", assignments: [] },
};
const STATUS: Status = {
  connections_needing_reconnect: 0,
  version: "1",
  git_sha: "abc",
  last_sync: null,
  failing_checks: [],
  secrets_expiring: [],
};

async function mount(
  me: Me,
  {
    summary = SUMMARY,
    agents = [],
    people = [PERSON],
    status = STATUS,
    statusFails = false,
    autoOpen = true,
    demo = false,
    found,
  }: {
    found?: SearchAnswer;
    summary?: typeof SUMMARY;
    agents?: Grant[];
    people?: People;
    status?: Status;
    statusFails?: boolean;
    autoOpen?: boolean;
    demo?: boolean;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(bookSummaryQuery.queryKey, summary);
  client.setQueryData(signInConfigQuery.queryKey, {
    ...configWith({
      name: "Metrics",
      company: null,
      logo_url: null,
      custom: false,
    }),
    demo,
  });
  if (found)
    client.setQueryData(searchQuery("sales", { limit: 50 }).queryKey, found);
  client.setQueryData(grantsQuery.queryKey, { grants: agents });
  client.setQueryData(peopleQuery.queryKey, people);
  if (!statusFails) client.setQueryData(statusQuery.queryKey, status);
  client.setQueryData(settingQuery("access.default_role").queryKey, {
    key: "access.default_role",
    value: "viewer",
    source: "default",
    environment_variable: "ACCESS_DEFAULT_ROLE",
    description: "Default role",
    environment_only: false,
    problem: null,
    check: null,
    redirect_uris: null,
  });
  const rootRoute = createRootRoute();
  const paths = [
    "/",
    "/catalog",
    "/settings/connections",
    "/admin",
    "/admin/people",
    "/admin/sign-in",
    "/admin/search",
    "/admin/secrets",
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      paths.map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => (
            <Home me={me} search={found ? { q: "sales" } : {}} />
          ),
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  const toggle = () =>
    host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  await act(async () => {
    await Promise.resolve();
    if (autoOpen) toggle()?.click();
  });
  return {
    host,
    client,
    titles: () =>
      [...host.querySelectorAll("summary")].map(
        (summary) => summary.querySelector("span span")?.textContent,
      ),
    unfolded: () =>
      [...host.querySelectorAll("details[open]")].map(
        (details) => details.querySelector("summary span span")?.textContent,
      ),
    /** The row's mark: its icon's colour says done or open. */
    done: (title: string) =>
      [...host.querySelectorAll("summary")]
        .find((summary) => summary.textContent.includes(title))
        ?.querySelector("svg")
        ?.getAttribute("class")
        ?.includes("text-accent"),
    status: (title: string) =>
      [...host.querySelectorAll("summary")]
        .find((summary) => summary.textContent.includes(title))
        ?.querySelector("span span:last-child")?.textContent,
    close: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
      client.clear();
    },
  };
}
it("asks a viewer only for what a viewer can do, and unfolds the next thing", async () => {
  const view = await mount(VIEWER);
  try {
    expect(view.titles()).toEqual([
      "Power BI is connected",
      "Connect your agent",
      "Ask your agent",
    ]);
    expect(view.unfolded()).toEqual(["Connect your agent"]);
    expect(view.host.textContent).toContain(
      "41 metrics in 5 datasets: 3 verified, 38 drafts",
    );
    expect(view.host.textContent).not.toContain("When you want more");
  } finally {
    view.close();
  }
});

it("moves on to asking once an agent is connected, in fixed words that name no metric", async () => {
  const view = await mount(VIEWER, { agents: [AGENT] });
  try {
    expect(view.titles()).toContain("Your agent is connected");
    expect(view.host.textContent).toContain(AGENT.client_id);
    expect(view.unfolded()).toEqual(["Ask your agent"]);
    expect(view.host.textContent).toContain(
      "Which of our metrics is the most widely used? What does it mean?",
    );
  } finally {
    view.close();
  }
});

it("leaves asking open with no agent, and while the connected agent has not asked", async () => {
  for (const agents of [[], [AGENT]]) {
    const view = await mount(VIEWER, { agents });
    try {
      expect(view.done("Ask your agent")).toBe(false);
      expect(view.unfolded()).toContain(
        agents.length === 0 ? "Connect your agent" : "Ask your agent",
      );
      expect(view.status("Ask your agent")).toBe(
        agents.length === 0
          ? "It answers from the book first, then from Power BI."
          : "Your agent is connected and has not asked anything yet.",
      );
    } finally {
      view.close();
    }
  }
});

it("marks asking done once an agent has reached the book", async () => {
  const view = await mount(
    { ...VIEWER, powerbi_connection: "not_connected" },
    {
      agents: [
        AGENT,
        { ...AGENT, id: "used", last_used_at: "2026-11-05T09:00:00Z" },
      ],
    },
  );
  try {
    expect(view.done("Ask your agent")).toBe(true);
    expect(view.status("Ask your agent")).toBe(
      "Your agent has reached the book. Here is more to ask it.",
    );
    expect(view.unfolded()).toEqual(["Connect Power BI"]);
  } finally {
    view.close();
  }
});

it("asks for the grants every 3 seconds until one exists, then every 30 until one is used", async () => {
  vi.useFakeTimers();
  const used = { ...AGENT, id: "used", last_used_at: "2026-11-05T09:00:00Z" };
  const cases: [Grant[], number, number][] = [
    [[], 1, 11],
    [[AGENT], 0, 1],
    [[used], 0, 0],
  ];
  try {
    for (const [agents, after3s, after33s] of cases) {
      askedForGrants.mockReset().mockResolvedValue({ grants: agents });
      const view = await mount(VIEWER, { agents });
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(askedForGrants).toHaveBeenCalledTimes(after3s);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(askedForGrants).toHaveBeenCalledTimes(after33s);
      } finally {
        view.close();
      }
    }
  } finally {
    vi.useRealTimers();
  }
});

it("gets a person back to Power BI first, and back to this page after", async () => {
  const view = await mount({
    ...VIEWER,
    powerbi_connection: "needs_reconnect",
  });
  try {
    expect(view.unfolded()).toEqual(["Connect Power BI"]);
    expect(view.host.textContent).toContain("Your connection has ended.");
    expect(
      [...view.host.querySelectorAll("a")].some(
        (link) =>
          link.getAttribute("href") === "/api/v1/powerbi/connect?next=%2F",
      ),
    ).toBe(true);
  } finally {
    view.close();
  }
});

it("says so when there is nothing to see, and asks a curator to structure nothing", async () => {
  const view = await mount(
    { ...VIEWER, roles: ["curator"] },
    { summary: EMPTY },
  );
  try {
    expect(view.host.textContent).toContain(
      "You can see nothing in the book yet.",
    );
    expect(view.titles().join(" ")).not.toContain("drafts");
  } finally {
    view.close();
  }
});

it("adds the drafts for a curator, and no admin work", async () => {
  const view = await mount({ ...VIEWER, roles: ["curator"] });
  try {
    expect(view.titles()).toContain("You have started structuring your drafts");
    expect(view.titles()).not.toContain("Invite your colleagues");
    expect(view.host.textContent).toContain(
      "Run pbmb curate and follow what it prints.",
    );
  } finally {
    view.close();
  }
});

it("gives an admin the invitation, what needs looking at, unfolded, and the optional settings", async () => {
  const view = await mount(
    { ...VIEWER, roles: ["admin"], may_admin: true },
    {
      agents: [AGENT],
      status: {
        ...STATUS,
        failing_checks: [
          {
            name: "expiry_powerbi_app_client_secret",
            message: "A secret has no expiry date.",
          },
        ],
        secrets_expiring: [
          {
            name: "powerbi_scanner_client_secret",
            expires_at: "2026-12-01T00:00:00Z",
            warning: "A secret expires in 9 days.",
          },
        ],
      },
    },
  );
  try {
    expect(view.titles()).toEqual([
      "Power BI is connected",
      "Your agent is connected",
      "Ask your agent",
      "You have started structuring your drafts",
      "Invite your colleagues",
    ]);
    expect(view.unfolded()).toEqual(["Ask your agent"]);
    expect(view.host.textContent).toContain("2 things to look at");
    const links = [...view.host.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toContain("/admin");
    expect(view.host.textContent).toContain(
      "Everyone in your tenant gets in, as a viewer.",
    );
    expect(view.host.textContent).toContain("When you want more");
  } finally {
    view.close();
  }
});

it("links a failing check to Status", async () => {
  const view = await mount(
    { ...VIEWER, may_admin: true },
    {
      status: {
        ...STATUS,
        failing_checks: [
          { name: "https", message: "The address is not served over HTTPS." },
        ],
      },
    },
  );
  try {
    const link = [...view.host.querySelectorAll("a")].find(
      (link) => link.textContent === "1 thing to look at",
    );
    expect(link?.getAttribute("href")).toBe("/admin");
  } finally {
    view.close();
  }
});

it("says so when the checks cannot be read, rather than showing nothing to look at", async () => {
  const view = await mount(
    { ...VIEWER, roles: ["admin"], may_admin: true },
    { statusFails: true },
  );
  try {
    // A fault, not a refusal: asked twice more before it counts as failed.
    await vi.waitFor(
      () => {
        expect(view.host.textContent).toContain("The checks could not be read");
      },
      { timeout: 5000 },
    );
  } finally {
    view.close();
  }
});

it("swaps the checks for one row when a later look fails, as the last answer stays cached", async () => {
  const view = await mount(
    { ...VIEWER, roles: ["admin"], may_admin: true },
    {
      status: {
        ...STATUS,
        failing_checks: [{ name: "a_check", message: "Something is wrong." }],
      },
    },
  );
  try {
    expect(view.host.textContent).toContain("1 thing to look at");
    void view.client.refetchQueries({ queryKey: statusQuery.queryKey });
    await vi.waitFor(
      () => {
        expect(view.host.textContent).toContain("The checks could not be read");
      },
      { timeout: 5000 },
    );
    expect(view.host.textContent).not.toContain("1 thing to look at");
  } finally {
    view.close();
  }
});

it("marks the invitation done once there is someone else", async () => {
  const view = await mount(
    { ...VIEWER, roles: ["admin"], may_admin: true },
    { people: [PERSON, { ...PERSON, id: "another" }] },
  );
  try {
    const row = [...view.host.querySelectorAll("summary")].find((summary) =>
      summary.textContent.includes("Invite your colleagues"),
    );
    expect(row?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-accent",
    );
  } finally {
    view.close();
  }
});

it("opens a small notice and returns focus after Escape, an outside click or a link", async () => {
  const view = await mount(VIEWER, { autoOpen: false });
  try {
    const button = view.host.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    );
    expect(button?.textContent).toBe("Finish setup 1 of 3");
    expect(view.host.querySelector("summary")).toBeNull();
    for (const close of ["escape", "outside", "link"]) {
      await act(async () => {
        await Promise.resolve();
        button?.click();
      });
      const panel = view.host.querySelector('[role="dialog"]');
      expect(document.activeElement).toBe(panel);
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      await act(async () => {
        await Promise.resolve();
        if (close === "escape")
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape" }),
          );
        else if (close === "outside") document.body.click();
        else {
          const link = panel?.querySelector("a");
          link?.addEventListener("click", (event) => {
            event.preventDefault();
          });
          link?.click();
        }
      });
      expect(view.host.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
    }
  } finally {
    view.close();
  }
});

const hit = (name: string): SearchHit => ({
  kind: "term",
  id: name,
  name,
  key: null,
  label: name,
  summary: "Money from sales",
  dataset: null,
  trust_state: null,
  score: 1,
  match: "meaning",
  path: [],
  icon: null,
  metric: null,
});
it("moves through the results by key, and back to the box", async () => {
  const view = await mount(VIEWER, {
    autoOpen: false,
    found: {
      items: [hit("alpha"), hit("beta")],
      counts: { term: 2 },
      search_id: null,
      search_mode: "hybrid",
      note: null,
    },
  });
  try {
    const box = view.host.querySelector<HTMLInputElement>("input[type=search]");
    const rows = () => [
      ...view.host.querySelectorAll<HTMLAnchorElement>("[data-search-row]"),
    ];
    const press = (target: Element | null, key: string) => {
      act(() => {
        target?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    };
    act(() => {
      document.body.focus();
    });
    press(document.body, "/");
    expect(document.activeElement).toBe(box);
    press(box, "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    press(rows()[0] ?? null, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    press(rows()[1] ?? null, "Escape");
    expect(document.activeElement).toBe(box);
    act(() => {
      rows()[1]?.focus();
    });
    expect(document.activeElement).toBe(rows()[1]);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      );
    });
    expect(document.activeElement).toBe(box);
  } finally {
    view.close();
  }
});

it("makes the first result the one tab stop of the list", async () => {
  const view = await mount(VIEWER, {
    autoOpen: false,
    found: {
      items: [hit("alpha"), hit("beta")],
      counts: { term: 2 },
      search_id: null,
      search_mode: "hybrid",
      note: null,
    },
  });
  try {
    const rows = [
      ...view.host.querySelectorAll<HTMLAnchorElement>("[data-search-row]"),
    ];
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);
  } finally {
    view.close();
  }
});

it("links the drafts to the curators' guide for a curator only", async () => {
  const guide = 'a[href="/docs/use/for-curators-drafts/"]';
  const viewer = await mount(VIEWER, { autoOpen: false });
  try {
    expect(viewer.host.querySelector(guide)).toBeNull();
  } finally {
    viewer.close();
  }
  const curator = await mount(
    { ...VIEWER, roles: ["curator"] },
    { autoOpen: false },
  );
  try {
    expect(curator.host.querySelector(guide)).not.toBeNull();
  } finally {
    curator.close();
  }
});

it("shows the setup notice outside the demo and none in it", async () => {
  const open = await mount(VIEWER, { autoOpen: false });
  try {
    expect(
      open.host.querySelector('button[aria-haspopup="dialog"]'),
    ).not.toBeNull();
  } finally {
    open.close();
  }
  const demo = await mount(VIEWER, { autoOpen: false, demo: true });
  try {
    expect(
      demo.host.querySelector('button[aria-haspopup="dialog"]'),
    ).toBeNull();
  } finally {
    demo.close();
  }
});
