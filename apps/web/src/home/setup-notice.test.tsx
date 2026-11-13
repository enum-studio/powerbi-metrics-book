// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Me } from "../api/me";
import { bookSummaryQuery } from "../catalog/queries";
import { AGENT } from "../setup/screen-test-support";
import { SetupNotice, setupSteps } from "./setup-notice";

const adminQueries = vi.hoisted(() => ({ people: vi.fn(), role: vi.fn() }));
vi.mock("../admin/access/api", async (importOriginal) => {
  const api = await importOriginal<typeof import("../admin/access/api")>();
  return {
    ...api,
    peopleQuery: { ...api.peopleQuery, queryFn: adminQueries.people },
  };
});
vi.mock("../admin/settings/api", async (importOriginal) => {
  const api = await importOriginal<typeof import("../admin/settings/api")>();
  return {
    ...api,
    settingQuery: (key: string) => ({
      ...api.settingQuery(key),
      queryFn: adminQueries.role,
    }),
  };
});
vi.mock("../access/connect-agent", () => ({
  useConnectedAgents: () => [{ ...AGENT, last_used_at: "2026-11-10" }],
  ConnectAgent: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
const ME: Me = {
  id: "me",
  kind: "person",
  email: "curator@sample.example",
  name: "Curator",
  roles: ["curator"],
  sign_in_method: "microsoft",
  via: "browser",
  powerbi_connection: "connected",
  powerbi_connect_url: "/api/v1/powerbi/connect",
  sample_data: true,
  usage: { capture: true, retention_days: 180 },
  may_admin: false,
  warnings: [],
  client_address: null,
};
const SUMMARY = {
  datasets: 37,
  metrics: { draft: 1167, agent_verified: 130, human_verified: 0 },
  not_filed: 1167,
};

async function mount(
  me = ME,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  client.setQueryData(bookSummaryQuery.queryKey, SUMMARY);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    await Promise.resolve();
    root.render(
      <QueryClientProvider client={client}>
        <SetupNotice me={me} />
      </QueryClientProvider>,
    );
  });
  return {
    host,
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}

it("closes the drafts step after verification even with 1167 drafts remaining", () => {
  const input = {
    me: ME,
    summary: SUMMARY,
    agents: [],
    people: undefined,
    role: undefined,
  };
  expect(setupSteps(input).find((item) => item.id === "drafts")).toMatchObject({
    title: "You have started structuring your drafts",
    state: "done",
  });
  expect(
    setupSteps({
      ...input,
      summary: {
        ...SUMMARY,
        metrics: { draft: 1167, agent_verified: 0, human_verified: 1 },
      },
    }).find((item) => item.id === "drafts")?.state,
  ).toBe("done");
  expect(
    setupSteps({
      ...input,
      summary: {
        ...SUMMARY,
        metrics: { draft: 1167, agent_verified: 0, human_verified: 0 },
      },
    }).find((item) => item.id === "drafts"),
  ).toMatchObject({ title: "Start structuring your drafts", state: "open" });
});

it("shows no setup checklist when every step is done", async () => {
  const view = await mount();
  try {
    expect(view.host.innerHTML).toBe("");
  } finally {
    view.close();
  }
});

it.each([
  { first: "people", connected: true },
  { first: "role", connected: true },
  { first: "people", connected: false },
  { first: "role", connected: false },
])(
  "waits for both admin queries and keeps five steps ($first fails first, connected: $connected)",
  async ({ first, connected }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const people = Promise.withResolvers<never>();
    const role = Promise.withResolvers<never>();
    adminQueries.people.mockImplementation(() => people.promise);
    adminQueries.role.mockImplementation(() => role.promise);
    const view = await mount(
      {
        ...ME,
        may_admin: true,
        powerbi_connection: connected ? "connected" : "not_connected",
      },
      client,
    );
    const settle = async (query: typeof people) => {
      await act(async () => {
        query.reject(new Error("Could not read setup data"));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    };
    try {
      expect(view.host.innerHTML).toBe("");
      await settle(first === "people" ? people : role);
      expect(view.host.innerHTML).toBe("");
      await settle(first === "people" ? role : people);
      expect(view.host.textContent).toBe(
        connected ? "Finish setup 4 of 5" : "Finish setup 3 of 5",
      );
    } finally {
      view.close();
    }
  },
);
