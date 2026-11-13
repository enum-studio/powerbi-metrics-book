// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiError, api as http } from "../../api/client";
import { useColumnPii } from "./column-pii";

it.each(["new", "existing", "conflict"])("undo %s", async (mode) => {
  const before = {
    id: "rule",
    kind: "column" as const,
    table_name: "Customer",
    name: "Phone",
    pii: false,
    note: "Reviewed",
    version: "v1",
    set_by_kind: "person",
    set_by_id: "another-admin",
    set_via: "browser",
    set_at: "2026-10-27T10:00:00Z",
  };
  const saved = {
    rule: { ...before, name: null, pii: true, version: "v2" },
    before: mode === "new" ? null : before,
    columns: 2,
    datasets: 2,
    measures: 0,
  };
  const put = vi
    .spyOn(http, "PUT")
    .mockResolvedValue({ data: saved, response: new Response() });
  const remove = vi
    .spyOn(http, "DELETE")
    .mockResolvedValue({ response: new Response(null, { status: 204 }) });
  const client = new QueryClient();
  // Refetches must neither block the buttons nor touch unrelated queries.
  const refresh = vi.spyOn(client, "invalidateQueries");
  refresh.mockReturnValue(new Promise(() => {}));
  const root = createRoot(document.createElement("div"));
  let hook: ReturnType<typeof useColumnPii> | undefined;
  function Probe() {
    hook = useColumnPii();
    return null;
  }
  const state = () => {
    if (!hook) throw new Error("Hook did not render");
    return hook;
  };
  try {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
    await vi.waitFor(() => {
      expect(hook).toBeDefined();
    });
    state().change.mutate({ table: "Customer", name: "Phone" });
    await vi.waitFor(() => {
      expect(state().notice?.message).toBe(
        "'Customer'[Phone] is PII in 2 columns of 2 datasets you can reach. People without pii_reader no longer see it.",
      );
    });
    expect(state().change.isPending).toBe(false);
    refresh.mockClear();
    const error = new ApiError(409, "conflict", "The rule changed.");
    if (mode === "conflict") put.mockRejectedValueOnce(error);
    state().notice?.undo?.();
    await vi.waitFor(() => {
      expect(state().notice?.message).toBe(
        mode === "conflict"
          ? `${error.message} Nothing was undone.`
          : "Undone.",
      );
    });
    if (mode !== "new") {
      expect(put.mock.lastCall?.[0]).toBe("/api/v1/admin/pii/rules");
      expect(put.mock.lastCall?.[1]).toHaveProperty("body", {
        kind: "column",
        table: "Customer",
        name: "Phone",
        pii: false,
        note: "Reviewed",
        expected_version: "v2",
      });
      expect(remove).not.toHaveBeenCalled();
    } else
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        "/api/v1/admin/pii/rules/{id}",
        { params: { path: { id: "rule" }, query: { expected_version: "v2" } } },
      );
    expect(refresh.mock.calls).toEqual([
      [{ queryKey: ["catalog"] }],
      [{ queryKey: ["metric"] }],
    ]);
  } finally {
    root.unmount();
    client.clear();
    vi.restoreAllMocks();
  }
});
