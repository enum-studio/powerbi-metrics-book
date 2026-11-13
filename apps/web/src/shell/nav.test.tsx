// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "../access/api";
import { configWith } from "./brand-test-support";
import { mount } from "../access/form-test-support";
import { AppFrame } from "./nav";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; href: string }) => unknown;
  }) => select({ pathname: "/", href: "/" }),
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
vi.mock("../catalog/search/search", () => ({
  CatalogSearch: ({ open }: { open: boolean }) =>
    open ? createElement("div", { role: "dialog" }, "Search dialog") : null,
}));
afterEach(() => vi.unstubAllGlobals());

const ME = {
  id: "sample",
  name: "Sample",
  email: "sample@example.com",
  may_admin: true,
  sample_data: true,
  usage: { capture: true, retention_days: 180 },
  kind: "person" as const,
  client_address: null,
  roles: ["admin"],
  sign_in_method: null,
  via: "browser" as const,
  powerbi_connection: null,
  powerbi_connect_url: "",
  warnings: [],
};

it("starts the first lane with Home, and searches from a button in its header", async () => {
  HTMLDialogElement.prototype.close = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const client = new QueryClient();
  const page = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AppFrame, { me: ME, band: null, children: null }),
    ),
  );
  try {
    const lane = page.host.querySelector('aside[aria-label="Sidebar"]');
    const main = lane?.querySelector('nav[aria-label="Main"]');
    expect(main?.querySelector("a")?.textContent).toBe("Home");
    expect(main?.textContent).not.toContain("Search");
    const search = lane?.querySelector<HTMLButtonElement>(
      'button[aria-label="Search the catalog"]',
    );
    expect(search).not.toBeNull();
    expect(page.host.querySelector('[role="dialog"]')).toBeNull();
    search?.click();
    await vi.waitFor(() => {
      expect(page.host.querySelector('[role="dialog"]')).not.toBeNull();
    });
  } finally {
    page.close();
    client.clear();
  }
});

it("shows the brand logo and name in the sidebar and mobile header", async () => {
  HTMLDialogElement.prototype.close = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(
    signInConfigQuery.queryKey,
    configWith({
      name: "Acme Metrics",
      company: "Acme",
      logo_url: "/api/branding/logo?v=abc",
      custom: true,
    }),
  );
  const page = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AppFrame, {
        me: {
          id: "sample",
          name: "Sample",
          email: "sample@example.com",
          may_admin: true,
          sample_data: true,
          usage: { capture: true, retention_days: 180 },
          kind: "person",
          client_address: null,
          roles: ["admin"],
          sign_in_method: null,
          via: "browser",
          powerbi_connection: null,
          powerbi_connect_url: "",
          warnings: [],
        },
        band: null,
        children: null,
      }),
    ),
  );
  try {
    expect(page.host.querySelectorAll('img[alt="Acme Metrics"]')).toHaveLength(
      2,
    );
    expect(page.host.textContent.match(/Acme Metrics/g)).toHaveLength(2);
  } finally {
    page.close();
    client.clear();
  }
});
