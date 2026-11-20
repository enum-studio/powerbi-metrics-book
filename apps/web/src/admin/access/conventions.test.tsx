// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  type CompanyPart,
  type ConventionRule,
  conventionCompanyQuery,
  conventionRulesQuery,
  conventionVersionsQuery,
  type ConventionVersion,
} from "./api";
import { WhatChanged } from "./conventions";

const rule = (
  id: string,
  value: unknown,
  source: ConventionRule["source"],
): ConventionRule => ({
  id,
  check: "metric_name_form",
  target: "metric",
  value,
  source,
  allowed: null,
  off: false,
  exceptions: 0,
});
const RULES = [
  rule("naming.case", "snake_case", "preset"),
  rule("naming.kinds", ["total_", "_rate"], "company"),
];
const VERSION: ConventionVersion = {
  version: 3,
  document: {},
  set_by: "Sample Admin",
  set_at: "2030-03-04T12:00:00Z",
};

async function mount(answers: {
  versions: ConventionVersion[];
  company: CompanyPart;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(conventionVersionsQuery.queryKey, answers.versions);
  client.setQueryData(conventionRulesQuery.queryKey, RULES);
  client.setQueryData(conventionCompanyQuery.queryKey, answers.company);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <WhatChanged preset="minimal" />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  return {
    host,
    close: () => {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}

it("lists the rules the company sets, by id, with their values", async () => {
  const view = await mount({
    versions: [VERSION],
    company: { format: 1, guide: "Our own words." },
  });
  try {
    const rows = [...view.host.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([["naming.kinds", '["total_","_rate"]']]);
    expect(view.host.textContent).toContain("The minimal preset");
    expect(view.host.textContent).toContain(
      "Version 3 was saved by Sample Admin",
    );
    expect(view.host.textContent).toContain(
      "The company sets 1 rule itself, and its own guide.",
    );
  } finally {
    view.close();
  }
});

it("says the preset is in force while no version is saved", async () => {
  const view = await mount({ versions: [], company: { format: 1 } });
  try {
    expect(view.host.textContent).toContain(
      "Nothing has been changed: the preset is in force.",
    );
  } finally {
    view.close();
  }
});
