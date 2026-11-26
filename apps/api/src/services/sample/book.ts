import { z } from "zod";
import { DOCS } from "./docs.js";

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
      "Revenue in a stated reporting currency and goods margin in EUR. Returned sales remain included; these are not net profit or cash measures.",
  },
  { path: "finance/margin", name: "Margin", description: null },
  {
    path: "retail",
    name: "Retail",
    description:
      "Store sales, returns and budgets. Money needs an explicit currency selection, and budget comparisons need matching months.",
  },
  {
    path: "retail/stock",
    name: "Stock",
    description:
      "Units and cost at one stock snapshot, read alongside product demand.",
  },
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
      "Use it for traffic. Read Conversion rate for the model's orders-to-sessions ratio, with its population caveats.",
    unit: "count",
  },
  {
    name: "conversion_rate",
    label: "Conversion rate",
    category: "web_analytics",
    definition:
      "All-channel orders divided by web sessions. This is a ratio of different populations unless the order channel is narrowed explicitly.",
    when_to_use:
      "Use it to investigate order-versus-traffic changes after checking that date and population filters are comparable.",
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
      "Net sales divided by ad spend: total filtered sales per euro spent, without attributing those sales to advertising.",
    when_to_use:
      "Use it to diagnose sales-versus-media-cost changes; confirm attribution before changing campaign budgets.",
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
      "Net sales, which always uses EUR. Both measures include returned sales; the distinction is currency selection.",
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

export async function call(
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

const docsSchema = z.record(z.string(), z.unknown());
const modelSchema = z.object({
  tables: z.array(z.object({ id: z.string(), name: z.string() })),
});
// A column or measure in a list carries the book's own fields beside Power BI's description.
const pageSchema = z.object({
  items: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      table: z.object({ name: z.string() }),
    }),
  ),
  next_cursor: z.string().nullable(),
});
type Item = z.infer<typeof pageSchema>["items"][number];

async function everyItem(send: Send, path: string): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  do {
    const after =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const page = pageSchema.parse(
      await call(send, "GET", `${path}?limit=500${after}`),
    );
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return items;
}

const WRITES_AT_ONCE = 8;

const UNIT_RULE = "column_fields.unit";
const companySchema = z.looseObject({
  exceptions: z
    .array(
      z.looseObject({
        rule: z.string(),
        dataset: z.string().optional(),
        column: z.string().optional(),
      }),
    )
    .optional(),
});
type Exception = {
  rule: string;
  reason: string;
  dataset: string;
  column: string;
};

/** Files an exception to the unit rule for each column DOCS says has none, beside the company's own; one already there is left as it is. */
async function fileExceptions(
  send: Send,
  wanted: Exception[],
): Promise<number> {
  const company = companySchema.parse(
    await call(send, "GET", "/conventions/company"),
  );
  const have = company.exceptions ?? [];
  const missing = wanted.filter(
    (one) =>
      !have.some(
        (each) =>
          each.rule === one.rule &&
          each.dataset === one.dataset &&
          each.column === one.column,
      ),
  );
  if (missing.length > 0)
    await call(send, "PUT", "/conventions", {
      ...company,
      exceptions: [...have, ...missing],
    });
  return missing.length;
}

/** The element DOCS names, or a loud failure: a renamed element must not lose its documentation quietly. */
function named<T>(found: T | undefined, what: string): T {
  if (found === undefined)
    throw new Error(
      `The sample tenant has no ${what}, which docs.ts documents.`,
    );
  return found;
}

/**
 * Writes DOCS through the sample admin's browser session, each field only
 * while it is empty, so a second run sends no PUT and a person's own text
 * stays.
 */
export async function seedSampleDocs(send: Send): Promise<string> {
  const written = { dataset: 0, table: 0, column: 0, measure: 0 };
  const exceptions: Exception[] = [];
  async function fill(
    kind: keyof typeof written,
    id: string,
    wanted: Record<string, string | undefined>,
    listed?: Record<string, unknown>,
  ) {
    const path = `/elements/${kind}/${id}/docs`;
    const have = listed ?? docsSchema.parse(await call(send, "GET", path));
    const empty = Object.entries(wanted).filter(
      ([field, value]) =>
        value !== undefined &&
        (typeof have[field] !== "string" || have[field].trim() === ""),
    );
    if (empty.length === 0) return;
    await call(send, "PUT", path, Object.fromEntries(empty));
    written[kind]++;
  }
  const { items: datasets } = datasetsSchema.parse(
    await call(send, "GET", "/datasets?limit=500"),
  );
  for (const [name, { tables, ...fields }] of Object.entries(DOCS)) {
    const dataset = named(
      datasets.find((each) => each.name === name),
      `dataset ${name}`,
    );
    const path = `/datasets/${dataset.id}`;
    const model = modelSchema.parse(await call(send, "GET", path));
    const columns = await everyItem(send, `${path}/columns`);
    const measures = await everyItem(send, `${path}/measures`);
    // The dataset's elements are all found before its first write; the writes go a few at a time.
    const writes = [() => fill("dataset", dataset.id, fields)];
    const find = (
      items: Item[],
      kind: string,
      table: string,
      element: string,
    ) =>
      named(
        items.find(
          (each) => each.table.name === table && each.name === element,
        ),
        `${kind} '${table}'[${element}] in ${name}`,
      );
    for (const [table, docs] of Object.entries(tables)) {
      const { columns: columnDocs, measures: measureDocs, ...own } = docs;
      const found = named(
        model.tables.find((each) => each.name === table),
        `table '${table}' in ${name}`,
      );
      writes.push(() => fill("table", found.id, own));
      for (const [column, { no_unit, ...wanted }] of Object.entries(
        columnDocs,
      )) {
        const listed = find(columns, "column", table, column);
        writes.push(() => fill("column", listed.id, wanted, listed));
        if (no_unit !== undefined)
          exceptions.push({
            rule: UNIT_RULE,
            reason: no_unit,
            dataset: name,
            column: `'${table}'[${column}]`,
          });
      }
      for (const [measure, description] of Object.entries(measureDocs ?? {})) {
        const listed = find(measures, "measure", table, measure);
        writes.push(() => fill("measure", listed.id, { description }, listed));
      }
    }
    for (let at = 0; at < writes.length; at += WRITES_AT_ONCE)
      await Promise.all(writes.slice(at, at + WRITES_AT_ONCE).map((w) => w()));
  }
  const filed = await fileExceptions(send, exceptions);
  const { dataset, table, column, measure } = written;
  return dataset + table + column + measure + filed === 0
    ? "Sample docs: already written, nothing changed."
    : `Sample docs: ${String(dataset)} datasets, ${String(table)} tables, ${String(column)} columns and ${String(measure)} measures documented, ${String(filed)} columns with no unit excepted.`;
}
