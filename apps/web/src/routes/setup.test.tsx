// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { grantsQuery, signInConfigQuery } from "../access/api";
import { meQuery } from "../api/me";
import { configWith } from "../shell/brand-test-support";
import { runStep, setupQuery, type SetupState } from "../setup/api";
import { SCREENS } from "../setup/screens";
import { rootRoute } from "./root";
import { setupRoute } from "./setup";

vi.mock("../shell/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => children,
  PAGE: "",
}));
vi.mock("../setup/api", async (original) => ({
  ...(await original<typeof import("../setup/api")>()),
  runStep: vi.fn(),
}));

it.each([
  ["microsoft", "admin", "microsoft"],
  ["sync", "admin", "sync"],
  ["done", "admin", "done", "viewer"],
  ["done", "admin", "done", "none"],
  ["done", "admin", "done", "curator"],
  ["microsoft", "setup_link", "address"],
  ["sync", "setup_link", "microsoft"],
  ["done", "setup_link", "microsoft"],
  ["people", "setup_link", "microsoft"],
  ["agent", "setup_link", "microsoft"],
  ["people", "admin", "microsoft"],
  ["agent", "admin", "microsoft"],
] as const)(
  "gives %s requested by %s the %s screen",
  async (screen, holder, expected, role = "viewer") => {
    vi.mocked(runStep).mockResolvedValue({
      step: "scanner",
      status: "failing",
      message: null,
      pending: true,
      next: null,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    const setup: SetupState = {
      holder,
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
        passed: id === "address" && expected !== "address",
        pending: id === "first_sync" && expected === "done",
        action: null,
        check:
          id === "address"
            ? {
                status: "passing",
                message: null,
                checked_at: "2026-10-29T00:00:00Z",
                details: {
                  public_base_url: "https://canonical.sample.example",
                  cookies_secure: true,
                },
              }
            : null,
      })),
    };
    client.setQueryData(setupQuery.queryKey, setup);
    client.setQueryData(meQuery.queryKey, null);
    client.setQueryData(
      signInConfigQuery.queryKey,
      configWith({
        name: "Metrics",
        company: null,
        logo_url: null,
        custom: false,
      }),
    );
    client.setQueryData(grantsQuery.queryKey, { grants: [] });
    client.setQueryData(["admin", "setting", "access.default_role"], {
      value: role,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([setupRoute]),
      context: { queryClient: client },
      history: createMemoryHistory({
        initialEntries: [`/setup?step=${screen}`],
      }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        await router.load();
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        );
      });
      expect(host.querySelectorAll("h1")).toHaveLength(1);
      expect(host.querySelector("h1")?.textContent).toBe(
        expected === "done"
          ? "The first sync is running"
          : SCREENS.find((screen) => screen.id === expected)?.title,
      );
      expect(router.state.location.search.step).toBe(expected);
      if (expected === "done")
        expect(host.textContent).toContain(
          role === "none"
            ? "Only the people you gave a role."
            : `Everyone in your tenant, as a ${role}.`,
        );
      expect(host.textContent.match(/Step [1-6] of 6/g) ?? []).toHaveLength(
        expected === "done" ? 0 : 1,
      );
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
      client.clear();
    }
  },
);
