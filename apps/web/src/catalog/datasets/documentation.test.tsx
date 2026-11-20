import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Documentation } from "./documentation";

const CASES = [
  {
    kind: "dataset",
    fields: ["When to use", "Owner", "Freshness", "Caveats"],
    values: {
      when_to_use: "Compare sales",
      owner: "Analytics team",
      freshness: "Every morning",
      caveats: "Returns excluded",
    },
  },
  {
    kind: "table",
    fields: ["Grain and filters", "Caveats"],
    values: {
      grain_and_filters: "One order line",
      caveats: "Test orders excluded",
    },
  },
  {
    kind: "column",
    fields: ["Unit", "Blank means"],
    values: { unit: "money", blank_means: "No amount recorded" },
  },
] as const;

function render(
  kind: "dataset" | "table" | "column",
  docs: Record<string, unknown> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(["conventions"], {
    rules: Object.fromEntries(
      CASES.map(({ kind }) => [
        `${kind}_fields`,
        {
          custom: [{ key: kind, label: `${kind} custom`, type: "text" }],
        },
      ]),
    ),
  });
  client.setQueryData(["catalog", "docs", kind, "sample"], {
    description: null,
    description_pbi: null,
    described_at: null,
    custom: {
      dataset: "Dataset value",
      table: "Table value",
      column: "Column value",
    },
    ...docs,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Documentation kind={kind} id="sample" details={[["Name", "Sample"]]} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

for (const { kind, fields, values } of CASES) {
  it(`shows the ${kind}'s definition, built-in fields, own custom fields and details in order`, () => {
    const html = render(kind, {
      description: "<b>Book definition</b>",
      description_pbi: "Power BI definition",
      ...values,
    });
    const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map(
      (match) => match[1],
    );
    expect(headings).toEqual([
      "Definition",
      "Description in Power BI",
      ...fields,
      `${kind} custom`,
      "Details",
    ]);
    expect(html).toContain("&lt;b&gt;Book definition&lt;/b&gt;");
    for (const value of Object.values(values)) expect(html).toContain(value);
    expect(html).not.toContain("From Power BI");
    expect(html).toContain("Sample");
  });

  it(`shows unwritten ${kind} fields even when optional`, () => {
    const html = render(kind, {
      ...Object.fromEntries(Object.keys(values).map((key) => [key, ""])),
      custom: {},
    });
    expect(html.match(/Not written yet/g)).toHaveLength(fields.length + 2);
    for (const label of ["Definition", ...fields])
      expect(html).toContain(label);
    expect(html).not.toContain("From Power BI");
    expect(html).not.toContain("Description in Power BI");
  });

  it(`uses Power BI's definition for an undocumented ${kind}`, () => {
    const html = render(kind, { description_pbi: "<b>Source definition</b>" });
    expect(html).toMatch(
      /Definition.*&lt;b&gt;Source definition&lt;\/b&gt;.*From Power BI/s,
    );
    expect(html).not.toContain("Description in Power BI");
  });

  it(`omits a duplicate Power BI description for a ${kind}`, () => {
    const html = render(kind, {
      description: "Same definition",
      description_pbi: "Same definition",
    });
    expect(html.match(/Same definition/g)).toHaveLength(1);
    expect(html).not.toContain("Description in Power BI");
    expect(html).not.toContain("From Power BI");
  });
}
