// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { exportsQuery } from "./queries";
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { mount } from "../../access/form-test-support";
import { Exports } from "./exports";

afterEach(() => vi.restoreAllMocks());
async function exportsPage(enabled: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(exportsQuery.queryKey, {
    markdown: enabled,
    pdf: enabled,
    guide: true,
  });
  return mount(
    createElement(QueryClientProvider, { client }, createElement(Exports)),
  );
}

it("checks PDF authorization before printing and expands reading sections only for print", async () => {
  const get = vi.spyOn(api, "GET").mockResolvedValue({
    data: { markdown: true, pdf: true, guide: true },
    response: new Response(),
  });
  document.documentElement.setAttribute("data-theme", "dark");
  const page = await exportsPage(true);
  const details = document.createElement("details");
  details.innerHTML = "<summary>Show all</summary><p>More metrics</p>";
  page.host.append(details);
  const print = vi.spyOn(window, "print").mockImplementation(() => {
    expect(details.open).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
  try {
    get.mockResolvedValue({ data: { markdown: "" }, response: new Response() });
    const button = [...page.host.querySelectorAll("button")].find(
      (b) => b.textContent === "Export PDF",
    );
    if (!button) throw new Error("Missing PDF export");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(get).toHaveBeenLastCalledWith("/api/v1/guide/export", {
      params: { query: { format: "pdf" } },
    });
    expect(print).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("afterprint"));
    expect(details.open).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  } finally {
    page.close();
    document.documentElement.removeAttribute("data-theme");
  }
});

it("hides exports disabled by the deployment", async () => {
  vi.spyOn(api, "GET").mockResolvedValue({
    data: { markdown: false, pdf: false, guide: true },
    response: new Response(),
  });
  const page = await exportsPage(false);
  try {
    expect(page.host.querySelectorAll("button")).toHaveLength(0);
  } finally {
    page.close();
  }
});

it("expands sections for the browser print command and restores them on unmount", async () => {
  const page = await exportsPage(false);
  const closed = document.createElement("details");
  const open = document.createElement("details");
  open.open = true;
  const editor = document.createElement("details");
  editor.className = "print:hidden";
  page.host.append(closed, open, editor);
  window.dispatchEvent(new Event("beforeprint"));
  expect(closed.open).toBe(true);
  expect(open.open).toBe(true);
  expect(editor.open).toBe(false);
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  page.close();
  expect(closed.open).toBe(false);
  expect(open.open).toBe(true);
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});
