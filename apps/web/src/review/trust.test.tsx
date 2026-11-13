// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { signInConfigQuery } from "../access/api";
import type { Me } from "../api/me";
import { configWith } from "../shell/brand-test-support";
import { checksQuery, type Metric } from "./queries";
import { Approve } from "./trust";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CURATOR = { id: "c", roles: ["curator"], may_admin: false } as Me;
const METRIC = {
  name: "Net sales",
  trust_state: "draft",
  failing_checks: [],
} as unknown as Metric;

function approveShown(demo: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(signInConfigQuery.queryKey, {
    ...configWith({
      name: "Metrics",
      company: null,
      logo_url: null,
      custom: false,
    }),
    demo,
  });
  client.setQueryData(checksQuery(METRIC.name).queryKey, []);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Approve metric={METRIC} me={CURATOR} />
      </QueryClientProvider>,
    );
  });
  const shown = host.textContent.includes("Approve");
  act(() => {
    root.unmount();
  });
  host.remove();
  return shown;
}

it("shows Approve to a curator, and hides it in the demo", () => {
  expect(approveShown(false)).toBe(true);
  expect(approveShown(true)).toBe(false);
});
