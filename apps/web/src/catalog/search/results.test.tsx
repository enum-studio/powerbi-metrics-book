import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ResultBody, Results } from "./results";
import type { SearchHit } from "./model";

const { data } = vi.hoisted(() => ({
  data: {
    items: [] as SearchHit[],
    counts: {
      metric: 13,
      variant: 8,
      term: 9,
      category: 2,
      dataset: 3,
      table: 4,
      column: 6,
    },
    search_id: null,
    search_mode: "hybrid" as const,
    note: null,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data }),
  queryOptions: (value: unknown) => value,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  linkOptions: (value: unknown) => value,
  Link: ({
    children,
    search,
  }: {
    children: React.ReactNode;
    search?: { q?: string; workspace?: string; trust?: string[] };
  }) => (
    <a
      data-q={search?.q}
      data-workspace={search?.workspace}
      data-trust={search?.trust?.join(",")}
    >
      {children}
    </a>
  ),
}));

it("renders ordered sections with API counts and five rows before Show all", () => {
  data.items = Object.keys(data.counts)
    .reverse()
    .flatMap((kind) =>
      Array.from({ length: 7 }, (_, index): SearchHit => ({
        kind: kind as SearchHit["kind"],
        id: `${kind}${String(index)}`,
        name: `${kind}${String(index)}`,
        key: null,
        label: `${kind}${String(index)}`,
        summary: "sales summary",
        dataset: null,
        trust_state: null,
        score: 1,
        match: "meaning",
        path: [
          { kind: "dataset", id: "dataset", name: "Sales", key: null },
          { kind: "table", id: "table", name: "Orders", key: null },
        ],
        icon: null,
        metric: { name: "sales", label: "Sales" },
      })),
    );
  const html = renderToStaticMarkup(<Results query="sales" data={data} />);
  const labels = [
    "Metrics (13)",
    "Metric variants (8)",
    "Terms (9)",
    "Categories (2)",
    "Datasets (3)",
    "Tables (4)",
    "Columns (6)",
  ];
  let previous = -1;
  for (const label of labels) {
    const position = html.indexOf(label);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(html).toContain("Show all 13");
  expect(html).toContain("metric4");
  expect(html).not.toContain("metric5");
});

it("draws a hit for the dialog's option without a link of its own", () => {
  const hit: SearchHit = {
    kind: "metric",
    id: "net_sales",
    name: "net_sales",
    key: null,
    label: "Net sales",
    summary: "Sales after returns",
    dataset: null,
    trust_state: null,
    score: 1,
    match: "meaning",
    path: [],
    icon: null,
    metric: null,
  };
  const html = renderToStaticMarkup(<ResultBody hit={hit} query="sales" />);
  expect(html).toContain("Net sales");
  expect(html).not.toContain("<a");
});

it("leads with the best match, and leaves it out of its own section", () => {
  const exact: SearchHit = {
    kind: "metric",
    id: "m1",
    name: "net_sales",
    key: null,
    label: "Net sales",
    summary: "Sales after returns",
    dataset: null,
    trust_state: null,
    score: 1,
    match: "exact",
    path: [
      { kind: "category", id: "c1", name: "Commercial", key: "commercial" },
    ],
    icon: null,
    metric: null,
  };
  data.items = [exact, { ...exact, id: "m2", name: "gross", label: "Gross" }];
  const html = renderToStaticMarkup(<Results query="sales" data={data} />);
  expect(html).toContain('aria-label="Best match"');
  expect(html).toContain('aria-label="Best match path"');
  expect(html).toContain("Commercial");
  expect(html.match(/Net sales/g)).toHaveLength(1);
  expect(html).toContain("Gross");
});

it("keeps the query and the filters on a best match's workspace link", () => {
  const hit: SearchHit = {
    kind: "table",
    id: "t1",
    name: "Orders",
    key: null,
    label: "Orders",
    summary: "Every order line",
    dataset: null,
    trust_state: null,
    score: 1,
    match: "exact",
    path: [
      { kind: "workspace", id: "w1", name: "Finance", key: null },
      { kind: "dataset", id: "d1", name: "Sales", key: null },
    ],
    icon: null,
    metric: null,
  };
  data.items = [hit];
  const html = renderToStaticMarkup(
    <Results query="orders" filters={{ trust: ["draft"] }} data={data} />,
  );
  expect(html).toContain(
    '<a data-q="orders" data-workspace="w1" data-trust="draft">Finance</a>',
  );
});

const measure: SearchHit = {
  kind: "variant",
  id: "v1",
  name: "Net sales LY",
  key: null,
  label: "Net sales",
  summary: "previous year",
  dataset: null,
  trust_state: "draft",
  score: 1,
  match: "words",
  path: [],
  icon: null,
  metric: { name: "net_sales", label: "Net sales" },
};

it("calls a measure by its own name, not its metric's label", () => {
  const html = renderToStaticMarkup(<ResultBody hit={measure} query="sales" />);
  expect(html).toContain("Net sales LY");
});

it("offers Show all when a section holds fewer hits than its count, five or under", () => {
  data.items = [
    {
      ...measure,
      id: "m1",
      kind: "metric",
      name: "a",
      label: "A",
      match: "meaning",
    },
    {
      ...measure,
      id: "m2",
      kind: "metric",
      name: "b",
      label: "B",
      match: "meaning",
    },
  ];
  const html = renderToStaticMarkup(
    <Results query="sales" data={{ ...data, counts: { metric: 4 } }} />,
  );
  expect(html).toContain("Show all 4");
});

it("names the best match's kind as the sections do", () => {
  data.items = [{ ...measure, match: "exact" }];
  const html = renderToStaticMarkup(
    <Results query="net sales ly" data={{ ...data, counts: { variant: 1 } }} />,
  );
  expect(html).toContain(">Metric variant<");
  expect(html).toContain("Net sales LY");
});
