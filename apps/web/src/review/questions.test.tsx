// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meQuery, type Me } from "../api/me";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { mount } from "../access/form-test-support";
import { useDemo } from "../shell/demo";
import { QuestionsSection } from "./questions";

vi.mock("../shell/demo", () => ({ useDemo: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function section(demo: boolean, questions = true) {
  vi.mocked(useDemo).mockReturnValue(demo);
  const get = vi.spyOn(api, "GET").mockReturnValue(new Promise(() => {}));
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData<Me>(meQuery.queryKey, {
    questions,
    id: "sample",
    kind: "person",
    email: null,
    name: "Sample",
    roles: [],
    sign_in_method: null,
    via: "browser",
    powerbi_connection: null,
    powerbi_connect_url: "",
    sample_data: true,
    usage: { capture: true, retention_days: 180 },
    may_admin: false,
    warnings: [],
    client_address: null,
  });
  const page = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(QuestionsSection, { metricId: "m1" }),
    ),
  );
  return { page, get };
}

it("draws no questions section and sends no threads request in the demo", async () => {
  const { page, get } = await section(true);
  try {
    expect(page.host.textContent).not.toContain("Open questions");
    expect(get).not.toHaveBeenCalled();
  } finally {
    page.close();
  }
});

it("draws the section and asks for the threads when demo is false", async () => {
  const { page, get } = await section(false);
  try {
    expect(page.host.textContent).toContain("Open questions");
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledWith("/api/v1/threads", expect.anything());
    });
  } finally {
    page.close();
  }
});

it("draws nothing and sends no threads request when questions are off", async () => {
  const { page, get } = await section(false, false);
  try {
    expect(page.host.innerHTML).toBe("");
    expect(get).not.toHaveBeenCalled();
  } finally {
    page.close();
  }
});
