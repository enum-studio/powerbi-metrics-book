// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { workspacesQuery } from "../queries";
import { Filters } from "./filters";
import type { SearchFilters } from "./model";

function show(value: SearchFilters) {
  const onChange = vi.fn<(next: SearchFilters) => void>();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(workspacesQuery.queryKey, [
    { id: "w1", name: "Sales" },
  ] as never);
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <QueryClientProvider client={client}>
        <Filters value={value} onChange={onChange} />
      </QueryClientProvider>,
    );
  });
  return { host, onChange };
}
function select(host: HTMLElement, label: string) {
  const found = host.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`No ${label} control`);
  return found;
}
function choose(control: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("sends measure for Metric variants and no kind for All", () => {
  const { host, onChange } = show({ kind: "metric" });
  choose(select(host, "Type"), "measure");
  expect(onChange).toHaveBeenLastCalledWith({ kind: "measure" });
  choose(select(host, "Type"), "");
  expect(onChange).toHaveBeenLastCalledWith({ kind: undefined });
});

it("turns an Add filter choice into a filter sent to the search", () => {
  const { host, onChange } = show({});
  choose(select(host, "Add filter"), "workspace");
  choose(select(host, "Choose workspace"), "w1");
  expect(onChange).toHaveBeenLastCalledWith({ workspace: "w1" });
});

it("shows held filters as chips and removes one on click", () => {
  const { host, onChange } = show({
    workspace: "w1",
    trust: ["draft", "human_verified"],
  });
  const remove = (label: string) => {
    act(() => {
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
    });
  };
  remove("Remove workspace");
  expect(onChange).toHaveBeenLastCalledWith({
    workspace: undefined,
    trust: ["draft", "human_verified"],
  });
  remove("Remove trust draft");
  expect(onChange).toHaveBeenLastCalledWith({
    workspace: "w1",
    trust: ["human_verified"],
  });
});

it("drops the trust filter when its last state is removed", () => {
  const { host, onChange } = show({ trust: ["draft"] });
  act(() => {
    host
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove trust draft"]',
      )
      ?.click();
  });
  expect(onChange).toHaveBeenLastCalledWith({ trust: undefined });
});

it("names a held workspace rather than showing its id", () => {
  const { host } = show({ workspace: "w1" });
  const chip = host.querySelector('button[aria-label="Remove workspace"]');
  expect(chip?.textContent).toContain("Sales");
  expect(chip?.textContent).not.toContain("w1");
});
