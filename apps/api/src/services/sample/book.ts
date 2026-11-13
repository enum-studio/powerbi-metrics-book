import { z } from "zod";

export type Send = (
  target: string,
  options?: { method?: string; json?: object },
) => Promise<Response>;
type Metric = {
  name: string;
  from?: string;
  label: string;
  category: string;
  definition: string;
  when_to_use: string;
  not_the_same_as?: string;
  aliases?: string[];
  unit: string;
};
type Term = {
  name: string;
  definition: string;
  not_the_same_as?: string;
  metrics: string[];
  columns?: [string, string, string][];
};
/** Parents before their children; a category is last among its siblings in this order. */
export const CATEGORIES = [
  {
    path: "sales",
    name: "Sales",
    description:
      "What customers bought: amounts, orders and baskets, from the order lines. Before returns unless a metric says otherwise.",
  },
  {
    path: "sales/orders",
    name: "Orders",
    description: "Counts of orders and what an order is worth.",
  },
  {
    path: "sales/returns",
    name: "Returns",
    description: "What came back, and how often.",
  },
  {
    path: "web_analytics",
    name: "Web analytics",
    description:
      "Visits to the web shop and what they turn into. Sessions come from the analytics tool, a day behind.",
  },
  {
    path: "marketing",
    name: "Marketing",
    description: "Spend to win customers, and what it returns.",
  },
  {
    path: "marketing/paid_media",
    name: "Paid media",
    description: "Ads on search and social, by week and channel.",
  },
  {
    path: "finance",
    name: "Finance",
    description:
      "Numbers as Finance books them: after returns, in the currency picked. Use these for the board, not for trading.",
  },
  { path: "finance/margin", name: "Margin", description: null },
];

/**
 * Drafts a curator merges: Finance's Revenue measure is the same calculation as
 * Net sales, and the sync keeps two names apart for a curator to decide.
 */
export const MERGES = [{ from: "revenue", into: "net_sales" }];

/**
 * The drafts the first sync makes of the sample tenant's measures, by name,
 * described and filed. Units are the conventions' own (money, count, rate,
 * ratio); the currency is in the definition. `from` is the draft's name when
 * it is renamed first: the draft for the measure that follows the currency
 * picked becomes the metric Revenue, once MERGES has freed the key.
 */
export const METRICS: Metric[] = [
  {
    name: "net_sales",
    label: "Net sales",
    category: "sales",
    definition:
      "The net amount of the order lines placed in the period: gross amount less discounts, before returns, in EUR.",
    when_to_use:
      "The default answer to how much we sold. Use it for trading, targets and channel splits.",
    not_the_same_as:
      "Revenue, which Finance reports in the currency picked on the page.",
    aliases: ["Sales", "Turnover"],
    unit: "money",
  },
  {
    name: "orders",
    label: "Orders",
    category: "sales/orders",
    definition: "The number of distinct orders placed in the period.",
    when_to_use:
      "Use it to count orders. For what they were worth, use Net sales.",
    unit: "count",
  },
  {
    name: "average_order_value",
    label: "Average order value",
    category: "sales/orders",
    definition:
      "Net sales divided by orders: what one order is worth on average, in EUR.",
    when_to_use: "Use it to compare baskets across channels and periods.",
    unit: "money",
  },
  {
    name: "return_rate",
    label: "Return rate",
    category: "sales/returns",
    definition:
      "The share of order lines the customer sent back, whole or in part.",
    when_to_use: "Use it to see how much of what we sell comes back.",
    unit: "rate",
  },
  {
    name: "sessions",
    label: "Sessions",
    category: "web_analytics",
    definition:
      "Visits to the web shop, counted by the analytics tool a day behind.",
    when_to_use:
      "Use it for traffic. For the share of visits that end in an order, use Conversion rate.",
    unit: "count",
  },
  {
    name: "conversion_rate",
    label: "Conversion rate",
    category: "web_analytics",
    definition:
      "Orders divided by sessions: the share of visits to the web shop that end in an order.",
    when_to_use: "Use it to judge the web shop and campaigns against traffic.",
    unit: "rate",
  },
  {
    name: "ad_spend",
    label: "Ad spend",
    category: "marketing/paid_media",
    definition: "What was spent on paid search and social ads, in EUR.",
    when_to_use:
      "Use it for the cost of winning customers. Read it with Return on ad spend.",
    unit: "money",
  },
  {
    name: "return_on_ad_spend",
    label: "Return on ad spend",
    category: "marketing/paid_media",
    definition:
      "Net sales divided by ad spend: the sales won for each euro spent on ads.",
    when_to_use: "Use it to compare what paid channels return for their spend.",
    unit: "ratio",
  },
  {
    name: "revenue",
    from: "revenue_in_selected_currency",
    label: "Revenue",
    category: "finance",
    definition:
      "The net amount of the order lines in the currency picked on the page, euros when none is picked.",
    when_to_use: "Use it for the board and for results Finance signs off.",
    not_the_same_as:
      "Net sales, which Sales counts before returns and always in EUR.",
    unit: "money",
  },
  {
    name: "gross_margin_percent",
    label: "Gross margin %",
    category: "finance/margin",
    definition:
      "Revenue less the cost of what was sold, as a share of revenue.",
    when_to_use:
      "Use it for how much of each euro of revenue is left as margin.",
    unit: "rate",
  },
];

/** `columns` are [dataset, table, column]; a term with columns becomes a dimension term, so Return has none and stays a concept. */
export const TERMS: Term[] = [
  {
    name: "Channel",
    definition:
      "Where the order was placed: the web shop, a store or a marketplace.",
    not_the_same_as: "Marketing channel, which is where the visitor came from.",
    metrics: ["net_sales", "orders"],
    columns: [
      ["Sales", "Channel", "Channel"],
      ["Marketing", "Channel", "Channel"],
    ],
  },
  {
    name: "Region",
    definition: "The sales region a customer or store belongs to.",
    metrics: ["net_sales"],
    columns: [["Sales", "Customer", "Region"]],
  },
  {
    name: "Return",
    definition: "An order line sent back by the customer, whole or in part.",
    metrics: ["return_rate"],
  },
];

const API = "/api/v1";
const metricSchema = z.object({
  name_is_generated: z.boolean(),
  definition: z.string().nullable(),
  category: z.object({ path: z.string() }).nullable(),
});
const termSchema = z.object({
  columns: z.array(z.object({ id: z.string() })),
  metrics: z.array(z.object({ name: z.string() })),
});
const datasetsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});
const columnsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});
type Category = { path: string; children: Category[] };
const categorySchema: z.ZodType<Category> = z.object({
  path: z.string(),
  children: z.array(z.lazy(() => categorySchema)),
});
const pathsIn = (nodes: Category[]): string[] =>
  nodes.flatMap((node) => [node.path, ...pathsIn(node.children)]);

async function call(
  send: Send,
  method: string,
  path: string,
  json?: object,
  accept = [200],
): Promise<unknown> {
  const response = await send(`${API}${path}`, { method, json });
  const text = await response.text();
  if (response.status === 404 && accept.includes(404)) return null;
  if (!accept.includes(response.status))
    throw new Error(
      `${method} ${API}${path}: the api answered ${String(response.status)}: ${text}`,
    );
  return text === "" ? null : (JSON.parse(text) as unknown);
}

/** Curation through the sample admin's browser session. A second run changes nothing. */
export async function seedSampleBook(send: Send): Promise<string> {
  const have = new Set(
    pathsIn(
      z.array(categorySchema).parse(await call(send, "GET", "/categories")),
    ),
  );
  let categories = 0;
  let metrics = 0;
  let terms = 0;
  for (const { path, name, description } of CATEGORIES) {
    if (have.has(path)) continue;
    await call(
      send,
      "POST",
      `/categories/${path}`,
      { name, description },
      [201],
    );
    categories++;
  }
  for (const { from, into } of MERGES) {
    const found = await call(
      send,
      "GET",
      `/metrics/${from}`,
      undefined,
      [200, 404],
    );
    if (found === null || !metricSchema.parse(found).name_is_generated)
      continue;
    await call(send, "POST", `/metrics/${into}/merge`, { from });
    metrics++;
  }
  for (const { name, from, ...wanted } of METRICS) {
    let found = await call(
      send,
      "GET",
      `/metrics/${name}`,
      undefined,
      [200, 404],
    );
    if (found === null && from !== undefined) {
      found = await call(send, "PATCH", `/metrics/${from}`, { name });
      metrics++;
    }
    if (found === null)
      throw new Error(
        `The sample tenant's first sync made no draft metric "${name}"`,
      );
    if (metricSchema.parse(found).definition) continue;
    await call(send, "PATCH", `/metrics/${name}`, wanted);
    metrics++;
  }
  const { items: datasets } = datasetsSchema.parse(
    await call(send, "GET", "/datasets"),
  );
  for (const { name, columns, metrics: relatedMetrics, ...fields } of TERMS) {
    const path = `/terms/${encodeURIComponent(name)}`;
    const found = await call(send, "GET", path, undefined, [200, 404]);
    if (found === null) {
      await call(send, "POST", path, fields, [201]);
      terms++;
    }
    const term =
      found === null ? { columns: [], metrics: [] } : termSchema.parse(found);
    const linked = new Set(term.columns.map((column) => column.id));
    for (const [dataset, table, column] of columns ?? []) {
      const model = datasets.find((each) => each.name === dataset);
      if (model === undefined)
        throw new Error(`No sample dataset "${dataset}"`);
      const { items } = columnsSchema.parse(
        await call(
          send,
          "GET",
          `/datasets/${model.id}/columns?table=${encodeURIComponent(table)}&name_prefix=${encodeURIComponent(column)}`,
        ),
      );
      const match = items.find((each) => each.name === column);
      if (match === undefined)
        throw new Error(`No column ${table}[${column}] in "${dataset}"`);
      if (linked.has(match.id)) continue;
      await call(send, "PUT", `${path}/columns/${match.id}`);
      terms++;
    }
    const related = new Set(term.metrics.map((metric) => metric.name));
    for (const metric of relatedMetrics) {
      if (related.has(metric)) continue;
      await call(send, "PUT", `${path}/metrics/${encodeURIComponent(metric)}`);
      terms++;
    }
  }
  return categories + metrics + terms === 0
    ? "Sample book: already seeded, nothing changed."
    : `Sample book: ${String(categories)} categories made, ${String(metrics)} metrics described and filed, ${String(terms)} term changes.`;
}
