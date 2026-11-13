import { randomUUID } from "node:crypto";
import pg from "pg";
import { roleUrl } from "./database.js";

/*
 * A book the size a large tenant's first sync leaves, every name invented:
 * many drafts, most of them one measure in one dataset and a few held by many
 * datasets, and names that share their words, as a real model's do. The rows
 * are committed in the test file's own database and analyzed, so a plan is the
 * plan such a book gets.
 */

export type LargeBook = {
  workspaceIds: string[];
  /** A draft held by many datasets, and one held by one. */
  wideMetric: string;
  narrowMetric: string;
};

const DATASETS = 50;
const DRAFTS = 9_000;
const CURATED = 100;
const MEASURES = 10_000;

const PREFIXES = [
  "Number of",
  "Total",
  "Net",
  "Gross",
  "Average",
  "Median",
  "Share of",
  "Count of",
  "Distinct",
  "New",
  "Repeat",
  "Active",
  "Lost",
  "Open",
  "Closed",
  "Paid",
  "Unpaid",
  "Late",
  "Early",
  "Cancelled",
];
const NOUNS = [
  "widgets",
  "gadgets",
  "parcels",
  "bookings",
  "returns",
  "invoices",
  "refunds",
  "subscriptions",
  "renewals",
  "visits",
  "leads",
  "tickets",
  "shipments",
  "pallets",
  "coupons",
  "vouchers",
  "quotes",
  "contracts",
  "stores",
  "customers",
  "sellers",
  "buyers",
  "clicks",
  "impressions",
  "carts",
  "checkouts",
  "payments",
  "fees",
  "margins",
  "discounts",
];
const SUFFIXES = [
  "",
  "LY",
  "LM",
  "LW",
  "LQ",
  "YTD",
  "MTD",
  "QTD",
  "YoY",
  "MoM",
  "WoW",
  "QoQ",
  "USD",
  "EUR",
  "Rolling 30",
  "Target",
];
const TABLES = ["Sales", "Stock", "Finance", "Support", "Measures"];
const COLUMNS_PER_TABLE = 30;
/** How many datasets hold one of the widely held drafts. */
const WIDTH = 10;

const measureNames = NOUNS.flatMap((noun) =>
  PREFIXES.flatMap((prefix) =>
    SUFFIXES.map((suffix) => `${prefix} ${noun} ${suffix}`.trim()),
  ),
);

/** The item `at` steps into the list, going round. */
const pick = <T>(list: T[], at: number): T => {
  const item = list[at % list.length];
  if (item === undefined) throw new Error("There is nothing to pick from.");
  return item;
};

const snake = (name: string) =>
  name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");

const dax = (name: string) =>
  `CALCULATE(SUM('Sales'[${name}]), FILTER(ALL('Date'), 'Date'[Year] = 2026))`;

type Column = readonly [string, string, unknown[]];

/** One `insert ... select from unnest(...)`, so thousands of rows are one statement. */
async function insertRows(
  client: pg.Client,
  table: string,
  columns: Column[],
): Promise<void> {
  const names = columns.map(([name]) => name).join(", ");
  const given = columns
    .map(([, type], at) => `$${String(at + 1)}::${type}[]`)
    .join(", ");
  await client.query(
    `insert into ${table} (${names}) select * from unnest(${given})`,
    columns.map(([, , values]) => values),
  );
}

export async function seedLargeBook(): Promise<LargeBook> {
  const client = new pg.Client({ connectionString: roleUrl("migrator") });
  await client.connect();
  try {
    await client.query("begin");
    const workspaceIds = Array.from({ length: Math.ceil(DATASETS / 4) }, () =>
      randomUUID(),
    );
    await insertRows(client, "powerbi_workspace", [
      ["id", "uuid", workspaceIds],
      ["name", "text", workspaceIds.map((_, i) => `Area ${String(i)}`)],
    ]);
    const datasetIds = Array.from({ length: DATASETS }, () => randomUUID());
    await insertRows(client, "powerbi_dataset", [
      ["id", "uuid", datasetIds],
      ["workspace_id", "uuid", datasetIds.map((_, i) => pick(workspaceIds, i))],
      ["name", "text", datasetIds.map((_, i) => `Model ${String(i)}`)],
    ]);

    const tables = datasetIds.flatMap((dataset_id) =>
      TABLES.map((name) => ({ id: randomUUID(), dataset_id, name })),
    );
    await insertRows(client, "powerbi_table", [
      ["id", "uuid", tables.map((t) => t.id)],
      ["dataset_id", "uuid", tables.map((t) => t.dataset_id)],
      ["name", "text", tables.map((t) => t.name)],
    ]);
    const columns = tables.flatMap((table) =>
      Array.from({ length: COLUMNS_PER_TABLE }, (_, i) => ({
        dataset_id: table.dataset_id,
        table_id: table.id,
        name: `Column ${String(i)}`,
      })),
    );
    await insertRows(client, "powerbi_column", [
      ["dataset_id", "uuid", columns.map((c) => c.dataset_id)],
      ["table_id", "uuid", columns.map((c) => c.table_id)],
      ["name", "text", columns.map((c) => c.name)],
      ["data_type", "text", columns.map(() => "String")],
      ["column_type", "text", columns.map(() => "data")],
    ]);

    const total = DRAFTS + CURATED;
    // Every metric holds one measure, and the first few hold WIDTH of them.
    const wide = Math.ceil((MEASURES - total) / (WIDTH - 1));
    const metrics: {
      id: string;
      name: string;
      label: string;
      curated: boolean;
    }[] = [];
    const measures: {
      id: string;
      dataset_id: string;
      table_id: string;
      name: string;
      metric_id: string;
    }[] = [];
    for (const [i, name] of measureNames.slice(0, total).entries()) {
      const id = randomUUID();
      metrics.push({
        id,
        name: snake(name),
        label: name,
        curated: i >= DRAFTS,
      });
      for (let copy = 0; copy < (i < wide ? WIDTH : 1); copy += 1) {
        const dataset_id = pick(datasetIds, i + copy);
        const inDataset = tables.filter((t) => t.dataset_id === dataset_id);
        measures.push({
          id: randomUUID(),
          dataset_id,
          table_id: pick(inDataset, measures.length).id,
          name,
          metric_id: id,
        });
      }
    }
    await insertRows(client, "powerbi_measure", [
      ["id", "uuid", measures.map((m) => m.id)],
      ["dataset_id", "uuid", measures.map((m) => m.dataset_id)],
      ["table_id", "uuid", measures.map((m) => m.table_id)],
      ["name", "text", measures.map((m) => m.name)],
      ["expression", "text", measures.map((m) => dax(m.name))],
      ["format_string", "text", measures.map(() => "#,0")],
    ]);
    await insertRows(client, "metric", [
      ["id", "uuid", metrics.map((m) => m.id)],
      ["name", "text", metrics.map((m) => m.name)],
      ["label", "text", metrics.map((m) => m.label)],
      ["origin", "text", metrics.map((m) => (m.curated ? "curator" : "sync"))],
      ["name_is_generated", "boolean", metrics.map((m) => !m.curated)],
      [
        "touched_at",
        "timestamptz",
        metrics.map((m) => (m.curated ? new Date() : null)),
      ],
    ]);
    await insertRows(client, "metric_variant", [
      ["metric_id", "uuid", measures.map((m) => m.metric_id)],
      ["measure_id", "uuid", measures.map((m) => m.id)],
      ["assigned_by", "text", measures.map(() => "sync")],
    ]);
    // One measure in twenty reads the selection, so a PII check has columns to judge.
    await client.query(
      `update metric_variant
          set reads_selection = true,
              selection_columns = array['''Sales''[Column 1]', '''Stock''[Column 2]']
        where measure_id = any($1::uuid[])`,
      [measures.filter((_, i) => i % 20 === 0).map((m) => m.id)],
    );
    await client.query(
      `insert into pii_rule (kind, table_name, name, pii, set_by_kind, set_by_id, set_via)
       select 'column', 'Sales', 'Column ' || i, true, 'person', 'seed', 'cli' from generate_series(0, 4) i
       union all
       select 'measure', 'Measures', 'Late customers ' || s, true, 'person', 'seed', 'cli' from unnest(array['LY', 'LM', 'YTD']) s
       union all
       select 'table', 'Support', null, true, 'person', 'seed', 'cli'`,
    );
    await client.query("commit");
    // Vacuum too, as autovacuum soon would: it empties a GIN index's pending list, which every scan reads through.
    await client.query("vacuum analyze");
    return {
      workspaceIds,
      wideMetric: pick(metrics, 0).name,
      narrowMetric: pick(metrics, wide).name,
    };
  } finally {
    await client.end();
  }
}

/** Ten drafts at the top of the queue, each holding these names in this many datasets. */
const CROWDED_DRAFTS = 10;
const CROWDED_WIDTH = 30;
const SPELLINGS = 3_000;
const CROWDED_SHIFTS = [
  "",
  "LY",
  "PY",
  "LM",
  "PM",
  "LQ",
  "PQ",
  "LW",
  "PW",
  "YTD",
  "MTD",
  "QTD",
  "Last year",
  "EUR",
  "DKK",
];

/**
 * Adds the drafts long-lived models leave at the top of the queue, every name
 * invented: each holds many shifts of a long name in many datasets, and a metric
 * one word away pairs with it, so what the queue reads for a page grows with the
 * names and variants those drafts hold. Apart from `seedLargeBook`, whose
 * first drafts hold one name each.
 */
export async function addCrowdedDrafts(): Promise<{
  metricNames: string[];
  spelledMetric: string;
}> {
  const client = new pg.Client({ connectionString: roleUrl("migrator") });
  await client.connect();
  try {
    await client.query("begin");
    const { rows: tables } = await client.query<{
      id: string;
      dataset_id: string;
    }>("select id, dataset_id from powerbi_table order by dataset_id, name");
    const datasets = [...new Set(tables.map((t) => t.dataset_id))];
    const metrics: { id: string; name: string; label: string }[] = [];
    const measures: {
      id: string;
      dataset_id: string;
      table_id: string;
      name: string;
      metric_id: string;
      base: boolean;
    }[] = [];
    const hold = (
      metric_id: string,
      name: string,
      base: boolean,
      dataset_id: string,
    ) => {
      const inDataset = tables.filter((t) => t.dataset_id === dataset_id);
      measures.push({
        id: randomUUID(),
        dataset_id,
        table_id: pick(inDataset, measures.length).id,
        name,
        metric_id,
        base,
      });
    };
    const metricNames: string[] = [];
    for (let draft = 0; draft < CROWDED_DRAFTS; draft += 1) {
      const name = `Crowded ${pick(NOUNS, draft)} net of late returns ${String(draft)}`;
      const id = randomUUID();
      metrics.push({ id, name: snake(name), label: name });
      metricNames.push(snake(name));
      for (const shift of CROWDED_SHIFTS)
        for (let copy = 0; copy < CROWDED_WIDTH; copy += 1)
          hold(
            id,
            `${name} ${shift}`.trim(),
            shift === "",
            pick(datasets, draft + copy),
          );
      const partner = randomUUID();
      const worded = `${name} SEK`;
      metrics.push({ id: partner, name: snake(worded), label: worded });
      hold(partner, worded, true, pick(datasets, draft));
    }
    // A draft of thousands of names one person could generate, each its own measure.
    const spelled = randomUUID();
    const spelledName = "Spelled widgets of a crafted model";
    metrics.push({
      id: spelled,
      name: snake(spelledName),
      label: spelledName,
    });
    for (let spelling = 0; spelling < SPELLINGS; spelling += 1)
      hold(
        spelled,
        `${spelledName} ${String(spelling)}`,
        true,
        pick(datasets, 0),
      );
    await insertRows(client, "powerbi_measure", [
      ["id", "uuid", measures.map((m) => m.id)],
      ["dataset_id", "uuid", measures.map((m) => m.dataset_id)],
      ["table_id", "uuid", measures.map((m) => m.table_id)],
      ["name", "text", measures.map((m) => m.name)],
      ["expression", "text", measures.map((m) => dax(m.name))],
      ["format_string", "text", measures.map(() => "#,0")],
    ]);
    await insertRows(client, "metric", [
      ["id", "uuid", metrics.map((m) => m.id)],
      ["name", "text", metrics.map((m) => m.name)],
      ["label", "text", metrics.map((m) => m.label)],
      ["origin", "text", metrics.map(() => "sync")],
      ["name_is_generated", "boolean", metrics.map(() => true)],
    ]);
    await insertRows(client, "metric_variant", [
      ["metric_id", "uuid", measures.map((m) => m.metric_id)],
      ["measure_id", "uuid", measures.map((m) => m.id)],
      ["assigned_by", "text", measures.map(() => "sync")],
      [
        "period",
        "text",
        measures.map((m) => (m.base ? "current" : "previous_year")),
      ],
    ]);
    await client.query("commit");
    await client.query("vacuum analyze");
    return { metricNames, spelledMetric: spelled };
  } finally {
    await client.end();
  }
}
