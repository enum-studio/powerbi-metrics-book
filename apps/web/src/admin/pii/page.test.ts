// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiError, api as http } from "../../api/client";
import { peopleQuery } from "../access/api";
import * as api from "./api";
import { PiiPage } from "./page";
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  createLink: () => () => null,
}));
async function restore(conflict: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const before = {
    id: "existing",
    kind: "column" as const,
    table_name: "Customer",
    name: "Email",
    pii: true,
    note: "B's rule",
    set_by_kind: "person",
    set_by_id: "B",
    set_via: "browser",
    set_at: "2026-10-27T10:00:00.000Z",
    version: "v1",
  };
  const saved = { ...before, pii: false, version: "v2" };
  const coverage = { columns: 1, measures: 0, datasets: 1 };
  const put = vi.spyOn(http, "PUT").mockResolvedValue({
    data: { rule: saved, before, ...coverage },
    response: new Response(),
  });
  const message =
    "The rule changed since; it was last set by b@example.com with the CLI.";
  const remove = vi.spyOn(http, "DELETE");
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  const rules = vi
    .spyOn(api.rulesQuery, "queryFn")
    .mockResolvedValue([{ ...saved, ...coverage, note: "Refreshed rule" }]);
  vi.spyOn(api.suggestionsQuery, "queryFn").mockResolvedValue([]);
  client.setQueryData(api.rulesQuery.queryKey, []);
  client.setQueryData(peopleQuery.queryKey, []);
  client.setQueryData(api.suggestionsQuery.queryKey, [
    {
      table_name: "Customer",
      column_name: "Email",
      dataset_id: "d",
      dataset_name: "Sample",
      matched: "email",
    },
  ]);
  const host = document.createElement("div");
  const root = createRoot(host);
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === text,
    );
    if (!button) throw new Error(`Missing ${text}`);
    await act(async () => {
      await Promise.resolve();
      button.click();
    });
  };
  try {
    await act(async () => {
      await Promise.resolve();
      root.render(
        createElement(QueryClientProvider, { client }, createElement(PiiPage)),
      );
    });
    await click("Not PII");
    rules.mockClear();
    if (conflict)
      put.mockRejectedValueOnce(new ApiError(409, "conflict", message));
    await click("Undo");
    expect(rules).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Refreshed rule");
    expect(host.textContent).toContain(
      conflict ? `${message} Nothing was undone.` : "Undone.",
    );
    expect(put.mock.lastCall?.[0]).toBe("/api/v1/admin/pii/rules");
    expect(put.mock.lastCall?.[1]).toHaveProperty("body", {
      kind: "column",
      table: "Customer",
      name: "Email",
      pii: true,
      note: "B's rule",
      expected_version: "v2",
    });
    expect(remove).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}
it.each([false, true])("restores a rule, with conflict: %s", restore);
