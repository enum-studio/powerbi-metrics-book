import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { type Invite, invitesQuery, type Person, peopleQuery } from "./api";

export const PERSON: Person = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ada Sample",
  email: "ada@sample.example",
  status: "active",
  deactivated_at: null,
  direct_role: "viewer",
  pii_reader: { source: "none", assignments: [] },
  title: "",
  sign_in_method: "microsoft",
  last_seen_at: null,
  powerbi_connection: "connected",
  grants: [],
  roles: [{ role: "viewer", assignments: [], by_default: false }],
};

/**
 * Mounts an access part under a router and a query client that holds the
 * given answers. A write's refetch is held back, so the part keeps showing
 * these answers after the write.
 */
export async function mountAccess(
  component: () => ReactNode,
  answers: { people?: Person[]; invites?: Invite[]; email_ready?: boolean },
) {
  // jsdom has no modal dialogs; an open one is all the parts need.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(peopleQuery.queryKey, answers.people ?? []);
  client.setQueryData(invitesQuery.queryKey, {
    invites: answers.invites ?? [],
    email_ready: answers.email_ready ?? true,
  });
  vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/admin/sign-in"].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component }),
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
    close() {
      act(() => {
        root.unmount();
      });
      client.clear();
      vi.restoreAllMocks();
    },
  };
}

export const buttons = (within: Element, text: string) =>
  [...within.querySelectorAll("button")].filter(
    (button) => button.textContent === text,
  );

export async function press(within: Element, text: string, index = 0) {
  const button = buttons(within, text)[index];
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

export function type(
  field: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
