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
  more: Partial<ConventionRule> = {},
): ConventionRule => ({
  id,
  check: "metric_name_form",
  target: "metric",
  value,
  source,
  allowed: null,
  off: false,
  exceptions: 0,
  ...more,
});
const RULES = [
  rule("naming.case", "snake_case", "preset", { off: true }),
  rule("naming.kinds", ["total_", "_rate"], "company", { exceptions: 2 }),
  rule("metric_fields.not_the_same_as", { required: true }, "company"),
  rule("metric_base_variant", null, "preset", { off: true, exceptions: 1 }),
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

it("lists every value the company sets, by rule id where one holds it, and what is off and excepted", async () => {
  const view = await mount({
    versions: [VERSION],
    company: {
      format: 1,
      preset: "minimal",
      guide: "Our own words.",
      naming: { kinds: ["total_", "_rate"], qualifiers: { per: ["per"] } },
      metric_fields: { not_the_same_as: { required: true } },
      trust: { human_verify_from: "browser" },
      drafting: { skip: { hidden_measures: false } },
      off: ["naming.case", "metric_base_variant"],
      exceptions: [],
    },
  });
  try {
    const rows = [...view.host.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["naming.kinds", '["total_","_rate"]'],
      ["naming.qualifiers.per", '["per"]'],
      ["metric_fields.not_the_same_as", '{"required":true}'],
      ["trust.human_verify_from", '"browser"'],
      ["drafting.skip.hidden_measures", "false"],
    ]);
    expect(view.host.textContent).toContain("The minimal preset");
    expect(view.host.textContent).toContain(
      "Version 3 was saved by Sample Admin",
    );
    expect(view.host.textContent).toContain(
      "The company sets 5 rules itself, and its own guide. 2 rules are off: naming.case, metric_base_variant. 3 exceptions let elements keep failing a rule.",
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
