// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, Suspense, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "../access/api";
import { mount } from "../access/form-test-support";
import { meQuery } from "../api/me";
import { configWith } from "./brand-test-support";
import { Shell } from "./shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ pathname: "/", href: "/" }),
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) =>
    select([]),
}));
vi.mock("./lane-edge", () => ({
  LaneEdge: () => null,
  useLaneSize: () => ({
    hidden: false,
    width: 260,
    chosen: 260,
    bounds: { min: 200, max: 400 },
    toggle: vi.fn(),
    change: vi.fn(),
  }),
}));
vi.mock("../catalog/tree/tree", () => ({ CatalogTree: () => null }));
vi.mock("../catalog/search/search", () => ({ CatalogSearch: () => null }));
afterEach(() => vi.unstubAllGlobals());

const ME = {
  id: "demo",
  name: "Demo",
  email: "viewer@sample.example",
  may_admin: true,
  sample_data: true,
  usage: { capture: true, retention_days: 180 },
  kind: "person" as const,
  client_address: null,
  roles: ["admin"],
  sign_in_method: "demo",
  via: "browser" as const,
  powerbi_connection: null,
  powerbi_connect_url: "",
  warnings: [],
};

async function shell(demo: boolean | "pending") {
  HTMLDialogElement.prototype.close = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(meQuery.queryKey, ME);
  if (demo === "pending") vi.stubGlobal("fetch", () => new Promise(() => {}));
  else
    client.setQueryData(signInConfigQuery.queryKey, {
      ...configWith({
        name: "Metrics",
        company: null,
        logo_url: null,
        custom: false,
      }),
      sample_data: true,
      demo,
    });
  return mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Suspense, null, createElement(Shell, null, null)),
    ),
  );
}

it("reads the demo sentence and links to the docs when demo is true, with no way out or to settings", async () => {
  const page = await shell(true);
  try {
    expect(page.host.textContent).toContain(
      "Demo on invented sample data. Read-only.",
    );
    expect(page.host.querySelector('a[href="/docs/start/"]')?.textContent).toBe(
      "Run it on your own Power BI",
    );
    expect(page.host.querySelector('[aria-label="Sign out"]')).toBeNull();
    expect(page.host.textContent).not.toContain("Settings");
    expect(page.host.textContent).not.toContain("Status");
  } finally {
    page.close();
  }
});

it("keeps the sample-data band, sign out and Settings when demo is false", async () => {
  const page = await shell(false);
  try {
    expect(page.host.textContent).not.toContain("Demo on invented");
    expect(page.host.textContent).toContain("invented sample tenant");
    expect(page.host.querySelector('[aria-label="Sign out"]')).not.toBeNull();
    expect(page.host.textContent).toContain("Settings");
  } finally {
    page.close();
  }
});

it("draws no Sign out or Settings while the config that says whether this is the demo is still coming", async () => {
  const page = await shell("pending");
  try {
    expect(page.host.querySelector('[aria-label="Sign out"]')).toBeNull();
    expect(page.host.textContent).not.toContain("Settings");
  } finally {
    page.close();
  }
});
