import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { closeTestPools, testPool } from "../../../test/deps.js";
import { addCrowdedDrafts, seedLargeBook } from "../../../test/large-book.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import * as schema from "../../db/schema/index.js";
import { currentConventions } from "../conventions/store.js";
import { nextDrafts } from "./drafts.js";
import { suggestMerges } from "./suggestions.js";

afterAll(closeTestPools);

/*
 * What the queue sends and reads when its drafts hold many names and variants.
 * As in reads_at_size.test.ts, this holds shapes and sizes and has no stopwatch.
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

const namesOf = ({ values }: Statement): string[] =>
  values.flatMap((value) =>
    Array.isArray(value)
      ? value.filter((one): one is string => typeof one === "string")
      : [],
  );
const charactersOf = (statement: Statement) =>
  namesOf(statement).reduce((sum, name) => sum + name.length, 0);
const pairingRead = (found: Statement[]) => {
  const read = found.find(
    (s) =>
      s.query.includes("regexp_replace") &&
      !s.query.includes('fingerprint" = any'),
  );
  if (read === undefined) throw new Error("No statement reads the pairing.");
  return read;
};

let crowded: Awaited<ReturnType<typeof addCrowdedDrafts>>;
let workspaceIds: string[];

beforeAll(async () => {
  ({ workspaceIds } = await seedLargeBook());
  crowded = await addCrowdedDrafts();
}, 120_000);

const curator = () =>
  asPerson(reaching({ powerbi_workspace_ids: workspaceIds }, "curator"), {
    db,
  });

it("keeps what a metric with thousands of names looks for within its bound", async () => {
  statements.length = 0;
  await suggestMerges(
    db,
    [crowded.spelledMetric],
    await currentConventions(db),
    sql`true`,
  );
  // Twice the bound in characters, because a name that holds a hint is looked for without it too.
  expect(charactersOf(pairingRead(statements))).toBeLessThan(4_000_000);
  expect(namesOf(pairingRead(statements)).length).toBeGreaterThan(1_000);
});

it("reads each of a page's names once, however many measures hold it", async () => {
  statements.length = 0;
  const queue = await nextDrafts(curator(), { limit: 10 });
  expect(queue.map((draft) => draft.name).sort()).toEqual(
    [...crowded.metricNames].sort(),
  );
  const names = statements.find((s) =>
    s.query.includes('group by "metric_variant"."metric_id"'),
  );
  if (names === undefined) throw new Error("No statement reads the names.");
  const { rows } = await testPool("api_rw").query(names.query, names.values);
  expect(rows).toHaveLength(10 * 15);
  expect(queue.flatMap((d) => d.variants).length).toBe(10 * 15 * 30);
});

it("does not show the planner a large array, which it would price element by element", async () => {
  statements.length = 0;
  await nextDrafts(curator(), { limit: 10 });
  const read = pairingRead(statements);
  expect(namesOf(read).length).toBeGreaterThan(5_000);
  expect(read.query).toContain("select unnest(");
  const { rows } = await testPool("api_rw").query<{ "QUERY PLAN": string }>(
    `explain ${read.query}`,
    read.values,
  );
  const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
  expect(plan).not.toMatch(/= ANY/);
});

it("still suggests the pair a crowded draft holds a word away", async () => {
  const queue = await nextDrafts(curator(), { limit: 10 });
  for (const draft of queue) {
    expect(draft.suggested_merges).toContainEqual(
      expect.objectContaining({ word: "SEK", axis: "currency" }),
    );
    expect(draft.hidden_suggested_merges).toBe(0);
  }
});
