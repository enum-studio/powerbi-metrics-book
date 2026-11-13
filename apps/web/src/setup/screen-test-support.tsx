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
import type { SetupState } from "./api";
import { grantsQuery, type Grant } from "../access/api";
import { rolesQuery } from "../admin/access/api";
import { settingQuery } from "../admin/settings/api";
import { AgentScreen } from "./agent";
import { Done } from "./done";
import { PeopleScreen } from "./people";
import { SignInScreen } from "./sign-in-screen";
import { Sync } from "./sync";

export const PUBLIC_BASE_URL = "https://canonical.sample.example";
export const AGENT: Grant = {
  id: "grant",
  client_id: "client",
  client_name: "Claude Code",
  via: "mcp",
  scopes: [],
  granted_at: "2026-11-04T00:00:00Z",
  last_used_at: null,
};
export const WORKSPACES = [
  { id: "sales", name: "Sales", personal: false },
  { id: "finance", name: "Finance", personal: false },
  { id: "personal", name: "My workspace", personal: true },
];
export async function mount(
  screen: "sign-in" | "sync" | "people" | "agent" | "done",
  holder: SetupState["holder"] = "admin",
  personal = false,
  /** What the app registration's step holds, over the failing check it holds by default. */
  app: Partial<SetupState["steps"][number]> = {},
  grants: Grant[] = [],
  /** What the first sync's step holds, over no check at all. */
  sync: Partial<SetupState["steps"][number]> = {},
) {
  const client = new QueryClient();
  client.setQueryData(settingQuery("access.default_role").queryKey, {
    key: "access.default_role",
    value: "none",
    source: "default",
    environment_variable: "ACCESS_DEFAULT_ROLE",
    description: "Default role",
    environment_only: false,
    problem: null,
    check: null,
    redirect_uris: null,
  });
  client.setQueryData(grantsQuery.queryKey, { grants });
  client.setQueryData(rolesQuery.queryKey, []);
  const setup: SetupState = {
    holder,
    completed_at: null,
    failure_docs_path: "/docs/set-up/when-a-check-fails/",
    steps: ["address", "app_registration", "what_to_sync"].map((id) => ({
      id,
      title: id,
      docs_path: "/docs/set-up/address/",
      fields: [
        {
          kind: "setting",
          key: "powerbi.sync.workspaces.personal",
          value: personal,
        },
      ],
      passed: false,
      pending: false,
      action:
        id === "app_registration" && holder === "admin" ? "connect" : null,
      check:
        id === "address"
          ? {
              status: "passing",
              message: null,
              checked_at: "2026-10-29T00:00:00Z",
              details: {
                public_base_url: PUBLIC_BASE_URL,
                cookies_secure: true,
              },
            }
          : id === "app_registration"
            ? {
                status: "failing",
                message: "The last connection failed.",
                checked_at: "2026-10-29T00:00:00Z",
              }
            : null,
      ...(id === "app_registration" ? app : {}),
    })),
  };
  setup.steps.push({
    id: "first_sync",
    title: "First sync",
    docs_path: "/docs/set-up/first-sync/",
    fields: [],
    passed: false,
    pending: false,
    action: null,
    check: null,
    ...sync,
  });
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup",
    validateSearch: (search: Record<string, unknown>) => ({
      step: String(search.step),
    }),
    component: () =>
      route.useSearch().step !== screen ? null : screen === "sync" ? (
        <Sync setup={setup} />
      ) : screen === "done" ? (
        <Done setup={setup} />
      ) : screen === "people" ? (
        <PeopleScreen setup={setup} />
      ) : screen === "agent" ? (
        <AgentScreen setup={setup} />
      ) : (
        <SignInScreen setup={setup} signedIn />
      ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/setup?step=${screen}`] }),
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
    router,
    client,
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}
export async function click(host: HTMLElement, text: string) {
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    );
    if (!button) throw new Error(`Missing button: ${text}`);
    button.click();
    await Promise.resolve();
  });
}
