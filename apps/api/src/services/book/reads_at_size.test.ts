import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPools, testPool } from "../../../test/deps.js";
import { type LargeBook, seedLargeBook } from "../../../test/large-book.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import type { ServiceContext } from "../../context.js";
import * as schema from "../../db/schema/index.js";
import type { Principal } from "../../principal.js";
import { getDocs } from "./docs.js";
import { nextDrafts } from "./drafts.js";
import {
  getMetric,
  metricChecks,
  summarizeBook,
  updateMetric,
  verifyMetric,
} from "./metrics.js";
import { listVariants } from "./variants.js";

afterAll(closeTestPools);

/*
 * The reads a curator waits on, on a book the size of a large tenant's. What
 * holds them is their shape, how many statements each runs, what its plans read
 * and how many bytes it answers, which a busy machine cannot make flaky as a
 * stopwatch could.
 */

type Statement = { query: string; values: unknown[] };
const statements: Statement[] = [];
const db = drizzle({
  client: testPool("api_rw"),
  schema,
  logger: {
    logQuery: (query, values) => statements.push({ query, values }),
  },
});

async function statementsOf(read: () => Promise<unknown>) {
  statements.length = 0;
  await read();
  return [...statements];
}

async function planOf(
  { query, values }: Statement,
  explain = "explain",
): Promise<string> {
  const { rows } = await testPool("api_rw").query<{ "QUERY PLAN": string }>(
    `${explain} ${query}`,
    values,
  );
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** What an agent pays to read an answer, and it depends on no machine. */
const bytes = (answer: unknown) => Buffer.byteLength(JSON.stringify(answer));

const onlyOne = (found: Statement[], text: string): Statement => {
  const [first, ...others] = found.filter((s) => s.query.includes(text));
  if (first === undefined || others.length > 0)
    throw new Error(`Not one statement holds ${text}.`);
  return first;
};

let book: LargeBook;
let hidesPii: ServiceContext;
let readsPii: ServiceContext;

beforeAll(async () => {
  book = await seedLargeBook();
  const curator: Principal = reaching(
    { powerbi_workspace_ids: book.workspaceIds },
    "curator",
  );
  hidesPii = asPerson(curator, { db });
  readsPii = asPerson({ ...curator, roles: ["curator", "pii_reader"] }, { db });
}, 120_000);

describe.each([
  ["a caller who may not read PII", () => hidesPii],
  ["a caller who may read PII", () => readsPii],
])("for %s", (_who, context) => {
  it("runs a number of statements that does not grow with the queue's page", async () => {
    const queue = await statementsOf(() =>
      nextDrafts(context(), { limit: 50 }),
    );
    expect(queue.length).toBeLessThanOrEqual(18);
  });

  it("asks for the closest metrics of every draft in one statement, through the trigram indexes", async () => {
    const queue = await statementsOf(() =>
      nextDrafts(context(), { limit: 10 }),
    );
    const plan = await planOf(onlyOne(queue, "similarity("));
    expect(plan).toContain("metric_name_trgm_idx");
    expect(plan).toContain("metric_label_trgm_idx");
  });

  it("reads the measures a likely merge can pair with, not every measure", async () => {
    const queue = await statementsOf(() =>
      nextDrafts(context(), { limit: 10 }),
    );
    const reads = queue.filter((s) => s.query.includes("regexp_replace"));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      const plan = await planOf(read);
      expect(plan).toContain("powerbi_measure_name_words_idx");
      expect(plan).not.toContain("Seq Scan on powerbi_measure");
    }
    expect(await planOf(onlyOne(reads, '"fingerprint" = any'))).toContain(
      "powerbi_measure_fingerprint_idx",
    );
  });

  it("answers ten drafts in under 100 KB, where the cross product of datasets cost 586 KB", async () => {
    const queue = await nextDrafts(context(), { limit: 10 });
    expect(queue).toHaveLength(10);
    expect(bytes(queue)).toBeLessThan(100_000);
  });

  it("gives one likely merge per pair of names, however many datasets hold them", async () => {
    const [widest, ...others] = await nextDrafts(context(), { limit: 10 });
    // Its name pairs with one measure for each of 9 words that mark a shift, each held by 10 datasets.
    expect(widest?.suggested_merges).toHaveLength(9);
    expect(
      widest?.suggested_merges.map((merge) => merge.dataset_count),
    ).toEqual(Array.from({ length: 9 }, () => 10));
    expect(bytes(widest?.suggested_merges)).toBeLessThan(2_500);
    for (const draft of others) {
      expect(draft.suggested_merges.length).toBeLessThanOrEqual(1);
    }
  });

  it("names a few labels in a failing check and counts the rest", async () => {
    for (const name of [book.wideMetric, book.narrowMetric]) {
      const { failing_checks } = await getMetric(context(), name);
      const failing = failing_checks.find(
        ({ check }) => check === "metric_not_the_same_as",
      );
      expect(failing?.message).toMatch(/^\d{3,} other metrics /);
      expect(failing?.other_labels).toHaveLength(10);
      // The ten labels, and the key and up to three datasets of the five closest metrics.
      expect(failing?.other_metrics).toHaveLength(5);
      expect(bytes(failing)).toBeLessThan(1_000);
      const all = (await metricChecks(context(), name)).find(
        ({ check }) => check === "metric_not_the_same_as",
      );
      expect(all?.other_labels?.length).toBeGreaterThan(99);
      expect(all?.other_labels?.slice(0, 10)).toEqual(failing?.other_labels);
    }
  });

  it("does not read the book to find one metric", async () => {
    const found = await statementsOf(() =>
      listVariants(context(), book.wideMetric),
    );
    const reads = found.filter((s) => s.query.startsWith("select"));
    expect(reads.length).toBeGreaterThan(0);
    for (const statement of reads) {
      expect(await planOf(statement)).not.toContain(
        "Seq Scan on metric_variant",
      );
    }
  });

  it("runs a number of statements that does not grow with the datasets holding a metric", async () => {
    const wide = await statementsOf(() =>
      getMetric(context(), book.wideMetric),
    );
    expect(wide.length).toBeLessThanOrEqual(18);
  });
});

it("counts the whole book, less what a PII rule hides", async () => {
  const all = await summarizeBook(readsPii);
  expect(all.datasets).toBe(50);
  expect(all.metrics.draft).toBe(9_100);
  const seen = await summarizeBook(hidesPii);
  expect(seen.metrics.draft).toBeLessThan(9_100);
  expect(seen.metrics.draft).toBeGreaterThan(9_090);
});

it("reads no other label for a metric whose not_the_same_as is written", async () => {
  await updateMetric(readsPii, book.narrowMetric, {
    not_the_same_as: "Not any of the others.",
  });
  const read = await statementsOf(() => getMetric(readsPii, book.narrowMetric));
  expect(read.filter((s) => s.query.includes("ilike any"))).toEqual([]);
});

it("reads only the labels that hold a compared word, for a metric that has none written", async () => {
  const read = await statementsOf(() => getMetric(readsPii, book.wideMetric));
  const labels = onlyOne(read, "ilike any");
  expect(labels.values.flat()).toContain("%widgets%");
});

it("reads every label to verify a metric, and not only those the page's filter keeps", async () => {
  const verifying = await statementsOf(() =>
    verifyMetric(readsPii, book.wideMetric).catch(() => undefined),
  );
  expect(verifying.filter((s) => s.query.includes("ilike any"))).toEqual([]);
  expect(
    verifying.filter((s) => s.query.startsWith('select "label" from "metric"')),
  ).toHaveLength(1);
});

it("finds a PII measure from its rule once per statement, not once per measure", async () => {
  const count = await statementsOf(() => summarizeBook(hidesPii));
  const plan = await planOf(
    onlyOne(count, '"trust_state"'),
    "explain (analyze, costs off, timing off)",
  );
  const scans = plan.match(/on pii_rule[^\n]*loops=\d+/g) ?? [];
  expect(scans.length).toBeGreaterThan(0);
  for (const scan of scans) expect(scan).toMatch(/loops=1$/);
});

it("reads one measure, not the mirror, to ask whether that measure is PII", async () => {
  const { rows } = await testPool("api_rw").query<{ id: string }>(
    "select id from powerbi_measure where name = 'Number of widgets' limit 1",
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("The book has no such measure.");
  const read = await statementsOf(() =>
    getDocs(hidesPii, { kind: "measure", id }),
  );
  const plan = await planOf(onlyOne(read, "ruled_measure"));
  expect(plan).toContain(
    "powerbi_measure_pkey on powerbi_measure ruled_measure",
  );
});

it("keeps no index on a measure's or a table's folded name, which an upgrade could leave stale", async () => {
  const { rows } = await testPool("api_rw").query(
    "select indexname from pg_indexes where tablename in ('powerbi_measure', 'powerbi_table') and indexdef ilike '%normalize%'",
  );
  expect(rows).toEqual([]);
});
