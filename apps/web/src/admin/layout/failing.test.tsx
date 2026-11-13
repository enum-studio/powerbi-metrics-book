// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { FailingChecks } from "./failing";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

async function linkOf(name: string) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <FailingChecks checks={[{ name, message: "Fails." }]} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  const link = host.querySelector("a");
  const answer = { href: link?.getAttribute("href"), text: link?.textContent };
  act(() => {
    root.unmount();
  });
  return answer;
}

it.each([
  ["scanner_secret_worker_only", "/admin/powerbi", "Open Power BI"],
  ["app_registration_read_only", "/admin/powerbi", "Open Power BI"],
  ["expiry_powerbi_app_client_secret", "/admin/secrets", "Open Secrets"],
])("links %s to the page that fixes it", async (name, href, text) => {
  expect(await linkOf(name)).toEqual({ href, text });
});

it.each(["https", "identity_volume_private"])(
  "links %s, which no admin page can fix, to the guide that quotes its sentence",
  async (name) => {
    expect(await linkOf(name)).toEqual({
      href: "/docs/set-up/when-a-check-fails/#security",
      text: "Read the guide",
    });
  },
);
