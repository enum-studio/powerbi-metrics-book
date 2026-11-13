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
import { expect, it } from "vitest";
import { grantsQuery, type Grant } from "../access/api";
import type { SetupState } from "./api";
import { Rail } from "./rail";
import type { ScreenId } from "./screens";
import { AGENT } from "./screen-test-support";

const passing = {
  status: "passing",
  message: null,
  checked_at: "2026-11-04T00:00:00Z",
} as const;

/** The first run with its sign-in done, and the first sync as given. */
const setup = (sync: Partial<SetupState["steps"][number]>): SetupState => ({
  holder: "admin",
  completed_at: null,
  failure_docs_path: "/docs/set-up/when-a-check-fails/",
  steps: [
    "address",
    "app_registration",
    "scanner",
    "what_to_sync",
    "first_sync",
  ].map((id) => ({
    id,
    title: id,
    docs_path: "/docs/set-up/address/",
    fields: [],
    passed: true,
    pending: false,
    action: null,
    check: passing,
    ...(id === "first_sync" ? { passed: false, check: null, ...sync } : {}),
  })),
});

async function statesOf(
  state: SetupState,
  current: ScreenId,
  grants: Grant[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(grantsQuery.queryKey, { grants });
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup",
    component: () => <Rail setup={state} current={current} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/setup"] }),
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
  const word = (title: string) =>
    [...host.querySelectorAll("li")]
      .find((row) => row.textContent.includes(title))
      ?.textContent.split(title)[1];
  const states = {
    people: word("Who gets in"),
    agent: word("Connect your agent"),
    progress: host.textContent.match(/\d of 6 steps done/)?.[0],
  };
  act(() => {
    root.unmount();
  });
  client.clear();
  return states;
}

const finished = setup({ passed: true, check: passing });

it("asks for both while the sync runs, on the first of them", async () => {
  expect(await statesOf(setup({ pending: true }), "people")).toEqual({
    people: "Waiting for you",
    agent: "Waiting for you",
    progress: "3 of 6 steps done",
  });
});

it("has done who gets in and skipped the agent once past them with no grant", async () => {
  expect(await statesOf(finished, "done")).toEqual({
    people: "Done",
    agent: "Skipped",
    progress: "5 of 6 steps done",
  });
});

it("has done the agent once there is a grant, whichever screen is open", async () => {
  expect(await statesOf(finished, "done", [AGENT])).toMatchObject({
    agent: "Done",
    progress: "6 of 6 steps done",
  });
  expect(
    await statesOf(setup({ pending: true }), "people", [AGENT]),
  ).toMatchObject({ agent: "Done" });
});

it("keeps its count when a person goes back after the first run", async () => {
  expect(await statesOf(finished, "sync", [AGENT])).toEqual({
    people: "Done",
    agent: "Done",
    progress: "6 of 6 steps done",
  });
  expect(await statesOf(finished, "sync")).toEqual({
    people: "Done",
    agent: "Waiting for you",
    progress: "5 of 6 steps done",
  });
});

it("asks again on the screen it is on", async () => {
  expect(await statesOf(finished, "agent")).toMatchObject({
    people: "Done",
    agent: "Waiting for you",
  });
});

it("skips nothing when the sync ends while a person is on Who gets in", async () => {
  expect(await statesOf(finished, "people")).toEqual({
    people: "Waiting for you",
    agent: "Waiting for you",
    progress: "4 of 6 steps done",
  });
});
