// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { signInConfigQuery } from "../../access/api";
import { configWith } from "../../shell/brand-test-support";
import { mount } from "../../access/form-test-support";
import { api } from "../../api/client";
import { meQuery } from "../../api/me";
import { secretsQuery, statusQuery, settingQuery } from "./api";
import { GeneralPage } from "./general-page";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  for (const key of ["branding.name", "branding.company", "questions.enabled"])
    client.setQueryData(settingQuery(key).queryKey, {
      key,
      value: key === "questions.enabled" ? false : null,
      source: "default",
      environment_variable: "",
      description:
        key === "questions.enabled" ? "Allow questions about the book." : "",
      environment_only: false,
      problem: null,
      check: null,
      redirect_uris: null,
    });
  client.setQueryData(secretsQuery.queryKey, []);
  client.setQueryData(statusQuery.queryKey, {
    connections_needing_reconnect: 0,
    version: "0.0.0",
    git_sha: "sample",
    last_sync: null,
    failing_checks: [],
    secrets_expiring: [],
  });
  return client;
}

it("uploads the file's bytes, says a refusal or a proxy's page, and refreshes the brand after upload and removal", async () => {
  const client = seededClient();
  client.setQueryData(
    signInConfigQuery.queryKey,
    configWith({
      name: "Acme Metrics",
      company: "Acme",
      logo_url: "/api/branding/logo?v=abc",
      custom: true,
    }),
  );
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const put = vi
    .spyOn(api, "PUT")
    .mockResolvedValueOnce({
      error: {
        error: "invalid",
        message: "The logo must be a PNG, JPEG or WebP image.",
      },
      response: new Response(null, { status: 400 }),
    })
    .mockResolvedValueOnce({
      error: "<html>Too large</html>",
      response: new Response(null, { status: 413 }),
    })
    .mockResolvedValue({ response: new Response(null, { status: 204 }) });
  const remove = vi
    .spyOn(api, "DELETE")
    .mockResolvedValue({ response: new Response(null, { status: 204 }) });
  const page = await mount(
    createElement(QueryClientProvider, { client }, createElement(GeneralPage)),
  );
  try {
    const input =
      page.host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing logo picker");
    expect(input.accept).toBe("image/png,image/jpeg,image/webp");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "sample.png", {
      type: "image/png",
    });
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const click = async (label: string) => {
      const button = [...page.host.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    };
    const alert = () => page.host.querySelector('[role="alert"]')?.textContent;
    invalidate.mockClear();
    await click("Upload");
    await vi.waitFor(() => {
      expect(alert()).toBe("The logo must be a PNG, JPEG or WebP image.");
    });
    await click("Upload");
    await vi.waitFor(() => {
      expect(alert()).toContain("The server answered 413");
    });
    expect(invalidate).not.toHaveBeenCalled();
    await click("Upload");
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: signInConfigQuery.queryKey,
      });
    });
    expect(put).toHaveBeenLastCalledWith(
      "/api/v1/admin/branding/logo",
      expect.objectContaining({
        body: file,
        headers: { "Content-Type": "image/png" },
      }),
    );
    invalidate.mockClear();
    await click("Remove");
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: signInConfigQuery.queryKey,
      });
    });
    expect(remove).toHaveBeenCalledWith("/api/v1/admin/branding/logo");
  } finally {
    page.close();
    client.clear();
  }
});

it("refetches the sign-in config after saving the brand name", async () => {
  const client = seededClient();
  const config = configWith({
    name: "Acme",
    company: null,
    logo_url: null,
    custom: true,
  });
  client.setQueryData(signInConfigQuery.queryKey, config);
  const get = vi
    .spyOn(api, "GET")
    .mockResolvedValue({ data: config, response: Response.json(config) });
  vi.spyOn(api, "PUT").mockResolvedValue({
    data: {},
    response: Response.json({}),
  });
  const invalidate = client.invalidateQueries.bind(client);
  vi.spyOn(client, "invalidateQueries").mockImplementation((filters) =>
    filters?.queryKey === signInConfigQuery.queryKey
      ? invalidate(filters)
      : Promise.resolve(),
  );
  const page = await mount(
    createElement(QueryClientProvider, { client }, createElement(GeneralPage)),
  );
  try {
    const input = page.host.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Missing brand name");
    get.mockClear();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "New brand");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      page.host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledWith("/api/auth/config");
    });
  } finally {
    page.close();
    client.clear();
  }
});

it("shows the Questions switch with its description and saves its boolean value", async () => {
  const client = seededClient();
  const put = vi
    .spyOn(api, "PUT")
    .mockResolvedValue({ data: {}, response: Response.json({}) });
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const page = await mount(
    createElement(QueryClientProvider, { client }, createElement(GeneralPage)),
  );
  try {
    const input = page.host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!input) throw new Error("Missing Questions switch");
    expect(
      page.host.querySelector(`label[for="${input.id}"]`)?.textContent,
    ).toContain("Questions");
    expect(page.host.textContent).toContain("Allow questions about the book.");
    expect(input.checked).toBe(false);
    act(() => {
      input.click();
    });
    act(() => {
      input
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledWith(
        "/api/v1/admin/settings/{key}",
        expect.objectContaining({
          params: { path: { key: "questions.enabled" } },
          body: { value: true, save_failing: false },
        }),
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: meQuery.queryKey });
    });
  } finally {
    page.close();
    client.clear();
  }
});
