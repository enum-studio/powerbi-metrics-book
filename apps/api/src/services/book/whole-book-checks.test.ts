import { eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { asPerson } from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { metric, term, termColumn } from "../../db/schema/book.js";
import * as schema from "../../db/schema/index.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { applyConventions } from "../conventions/apply.js";
import { exceptionKey } from "../conventions/schema.js";
import { resolve } from "../conventions/store.js";
import { METRICS, TERMS } from "../sample/book.js";
import { metricChecks } from "./metrics.js";
import {
  checkedElements,
  failuresInBook,
  unusedExceptions,
} from "./whole-book-checks.js";

import { TEST_RUNNER } from "../../../test/database.js";
import { exceptionIndex } from "./checks.js";
import { setRole } from "../../../test/sample-mirror.js";
import { piiRule } from "../../db/schema/pii.js";

afterAll(closeTestPools);

const statements: string[] = [];
const logged = drizzle({
  client: testPool(TEST_RUNNER),
  schema,
  logger: { logQuery: (query) => statements.push(query) },
});

/** The work runs in a transaction that is rolled back, each statement it sends counted. */
const rolledBack = (work: (tx: Db) => Promise<void>) =>
  expect(
    logged.transaction(async (tx) => {
      await setRole(tx, "api_rw");
      await work(tx);
      tx.rollback();
    }),
  ).rejects.toThrow(TransactionRollbackError);

const metricsBook = resolve({});

/** The sample company's metrics and terms, as curated, none filed under a measure. */
async function sampleBook(tx: Db): Promise<void> {
  await tx.insert(metric).values(
    METRICS.map(
      ({
        name,
        label,
        definition,
        when_to_use,
        not_the_same_as,
        aliases,
        unit,
      }) => ({
        name,
        label,
        definition,
        when_to_use,
        not_the_same_as,
        aliases,
        unit,
        origin: "curator" as const,
      }),
    ),
  );
  await tx.insert(term).values(
    TERMS.map(({ name, definition, not_the_same_as }) => ({
      name,
      definition,
      not_the_same_as,
    })),
  );
}

/** Drafts whose labels share their words, as a real model's do. */
async function generatedBook(tx: Db, count: number): Promise<void> {
  const words = ["orders", "sales", "returns", "visits", "margin", "stock"];
  await tx.insert(metric).values(
    Array.from({ length: count }, (_, at) => ({
      name: `draft_${String(at)}`,
      label: `Draft ${words[at % words.length] ?? ""} ${String(at)}`,
      origin: "sync" as const,
      name_is_generated: true,
    })),
  );
}

const ofRule = (failures: { rule: string }[], rule: string) =>
  failures.filter((failure) => failure.rule === rule);

describe("failuresInBook", () => {
  it("fails each sample metric on the rules its own checks fail, and a term on its own", () =>
    rolledBack(async (tx) => {
      await sampleBook(tx);
      await tx.insert(term).values({ name: "Undefined term", definition: "" });
      const failures = await failuresInBook({ db: tx }, metricsBook);
      const admin = asPerson(principals.admin, { db: tx });
      for (const { name } of METRICS) {
        const own = (await metricChecks(admin, name))
          .filter((result) => !result.passed)
          .map((result) => result.rule);
        expect(
          failures
            .filter((failure) => failure.target.metric === name)
            .map((failure) => failure.rule),
          name,
        ).toEqual(own);
      }
      expect(
        failures.filter((failure) => failure.target.term !== undefined),
      ).toEqual([
        { rule: "term_fields.definition", target: { term: "Undefined term" } },
      ]);
    }));

  it("checks several hundred drafts in a few statements, each rule once a draft", () =>
    rolledBack(async (tx) => {
      await generatedBook(tx, 600);
      statements.length = 0;
      const failures = await failuresInBook({ db: tx }, metricsBook);
      expect(statements.length).toBeLessThanOrEqual(5);
      expect(ofRule(failures, "metric_name_generated")).toHaveLength(600);
      expect(ofRule(failures, "metric_base_variant")).toHaveLength(600);
      // Every label shares its word with a hundred others.
      expect(ofRule(failures, "metric_fields.not_the_same_as")).toHaveLength(
        600,
      );
      const keys = failures.map((failure) =>
        JSON.stringify([failure.rule, failure.target]),
      );
      expect(new Set(keys).size).toBe(keys.length);
    }));

  it("leaves out what an exception covers and what is off, and reads only the rules asked for", () =>
    rolledBack(async (tx) => {
      await generatedBook(tx, 3);
      const conventions = resolve({
        off: ["metric_base_variant"],
        exceptions: [
          { rule: "metric_name_generated", metric: "draft_1", reason: "Kept." },
        ],
      });
      const failures = await failuresInBook(
        { db: tx },
        conventions,
        new Set(["metric_name_generated", "metric_base_variant"]),
      );
      expect(failures).toEqual([
        { rule: "metric_name_generated", target: { metric: "draft_0" } },
        { rule: "metric_name_generated", target: { metric: "draft_2" } },
      ]);
    }));
});

describe("unusedExceptions", () => {
  it("names an exception whose target is gone or passes without it, and keeps one in use", () =>
    rolledBack(async (tx) => {
      await sampleBook(tx);
      await generatedBook(tx, 2);
      const conventions = resolve({
        exceptions: [
          { rule: "metric_name_generated", metric: "draft_0", reason: "Used." },
          { rule: "metric_name_generated", metric: "net_sales", reason: "No." },
          { rule: "naming.kinds", metric: "no_such_metric", reason: "Gone." },
          {
            rule: "term_fields.definition",
            term: "Channel",
            reason: "Defined.",
          },
        ],
      });
      expect(await unusedExceptions({ db: tx }, conventions)).toEqual([
        {
          rule: "metric_name_generated",
          target: { metric: "net_sales" },
          reason: "No.",
          why: "passes",
        },
        {
          rule: "naming.kinds",
          target: { metric: "no_such_metric" },
          reason: "Gone.",
          why: "no_such_target",
        },
        {
          rule: "term_fields.definition",
          target: { term: "Channel" },
          reason: "Defined.",
          why: "passes",
        },
      ]);
      expect(
        await unusedExceptions({ db: tx }, conventions, { metric: "draft_0" }),
      ).toEqual([]);
      expect(
        await unusedExceptions({ db: tx }, conventions, { term: "Channel" }),
      ).toMatchObject([{ target: { term: "Channel" }, why: "passes" }]);
    }));

  it("counts an exception to a rule that is off as unused", () =>
    rolledBack(async (tx) => {
      await generatedBook(tx, 1);
      const conventions = resolve({
        off: ["metric_name_generated"],
        exceptions: [
          { rule: "metric_name_generated", metric: "draft_0", reason: "Off." },
        ],
      });
      expect(await unusedExceptions({ db: tx }, conventions)).toMatchObject([
        { why: "passes", target: { metric: "draft_0" } },
      ]);
    }));
});

describe("whole-book element checks", () => {
  useMirror();
  it("derives term backing, numeric keys, date and fact kinds from the mirror", () =>
    rolledBack(async (tx) => {
      const [linked] = await tx
        .insert(term)
        .values({ name: "Channel meaning" })
        .returning();
      if (linked === undefined) throw new Error("Term was not inserted.");
      await tx
        .insert(termColumn)
        .values({ term_id: linked.id, column_id: id.channel });
      await setRole(tx, "worker_rw");
      await tx
        .update(schema.powerbiRelationship)
        .set({ cardinality: "many_to_one" })
        .where(eq(schema.powerbiRelationship.dataset_id, id.sales));
      await tx
        .update(schema.powerbiColumn)
        .set({ data_type: "Int64" })
        .where(eq(schema.powerbiColumn.id, id.order_date));
      await tx.insert(schema.powerbiColumn).values({
        dataset_id: id.sales,
        table_id: id.date_table,
        name: "Date",
        data_type: "DateTime",
        column_type: "data",
      });
      await setRole(tx, "api_rw");
      const run = {
        conventions: metricsBook,
        exceptions: exceptionIndex(metricsBook),
      };
      const rows = await checkedElements({ db: tx }, run);
      const passes = (id: string, rule: string) =>
        rows
          .find((row) => row.id === id)
          ?.results.find((result) => result.rule === rule)?.passed;
      expect(passes(id.channel, "column_fields.definition")).toBe(true);
      expect(passes(id.order_date, "column_fields.unit")).toBe(true);
      expect(
        rows
          .find((row) => row.id === id.date_table)
          ?.results.every((result) => result.passed),
      ).toBe(true);
      expect(passes(id.sales_table, "table_fields.grain_and_filters")).toBe(
        false,
      );
      await tx.insert(piiRule).values({
        kind: "column",
        table_name: "Date",
        name: "Date",
        set_by_kind: "person",
        set_by_id: principals.admin.id,
        set_via: "browser",
        pii: true,
      });
      const viewer = await checkedElements({ db: tx }, run, undefined, true);
      expect(viewer).toEqual(
        rows.filter((row) => !(row.kind === "column" && row.table === "Date")),
      );
    }));

  it("asks nothing of hidden tables or their visible numeric columns", () =>
    rolledBack(async (tx) => {
      await setRole(tx, "worker_rw");
      await tx
        .update(schema.powerbiTable)
        .set({ is_hidden: true })
        .where(eq(schema.powerbiTable.id, id.sales_table));
      await tx
        .update(schema.powerbiColumn)
        .set({ data_type: "Double" })
        .where(eq(schema.powerbiColumn.id, id.channel));
      await setRole(tx, "api_rw");
      const rows = await checkedElements(
        { db: tx },
        { conventions: metricsBook, exceptions: exceptionIndex(metricsBook) },
      );
      const hidden = rows.filter(
        (row) => row.id === id.sales_table || row.table === "Sales",
      );
      expect(hidden.length).toBeGreaterThan(1);
      expect(
        hidden.every((row) => row.results.every((result) => result.passed)),
      ).toBe(true);
    }));

  it("includes element failures and unused exceptions, with a constant number of reads", () =>
    rolledBack(async (tx) => {
      const conventions = resolve({
        exceptions: [
          {
            rule: "dataset_fields.definition",
            dataset: "Sales",
            reason: "Already documented.",
          },
          {
            rule: "table_fields.definition",
            dataset: "Sales",
            table: "Sales",
            reason: "Kept.",
          },
          {
            rule: "column_fields.definition",
            dataset: "Sales",
            column: "'Sales'[Missing]",
            reason: "Gone.",
          },
        ],
      });
      statements.length = 0;
      const failures = await failuresInBook(
        { db: tx },
        conventions,
        new Set([
          "dataset_fields.when_to_use",
          "table_fields.definition",
          "column_fields.definition",
        ]),
      );
      expect(statements).toHaveLength(6);
      expect(failures).toContainEqual({
        rule: "dataset_fields.when_to_use",
        target: { dataset: "Sales" },
      });
      expect(failures).not.toContainEqual({
        rule: "table_fields.definition",
        target: { dataset: "Sales", table: "Sales" },
      });
      expect(failures).toContainEqual({
        rule: "column_fields.definition",
        target: { dataset: "Sales", column: "'Sales'[Channel]" },
      });
      const checked = await checkedElements(
        { db: tx },
        { conventions, exceptions: exceptionIndex(conventions) },
      );
      const reads = statements.length;
      const unused = await unusedExceptions(
        { db: tx },
        conventions,
        undefined,
        checked,
      );
      expect(statements).toHaveLength(reads);
      expect(unused).toEqual([
        {
          rule: "dataset_fields.definition",
          target: { dataset: "Sales" },
          reason: "Already documented.",
          why: "passes",
        },
        {
          rule: "column_fields.definition",
          target: { dataset: "Sales", column: "'Sales'[Missing]" },
          reason: "Gone.",
          why: "no_such_target",
        },
      ]);
    }));

  it("includes element failures in apply and sorts the baseline's exceptions", () =>
    rolledBack(async (tx) => {
      const answer = await applyConventions({ db: tx }, principals.admin, {
        conventions: {
          format: 1,
          dataset_fields: { owner: { required: true } },
        },
        dry_run: false,
        baseline_reason: "Document later.",
      });
      expect(answer.now_failing["dataset_fields.owner"]).toBeGreaterThan(0);
      expect(answer.exceptions_added).toContainEqual({
        rule: "dataset_fields.owner",
        dataset: "Sales",
        reason: "Document later.",
      });
      for (const dataset of [id.twin_a, id.twin_b]) {
        expect(answer.exceptions_added).toContainEqual({
          rule: "dataset_fields.owner",
          dataset,
          reason: "Document later.",
        });
      }
      expect(answer.version).not.toBeNull();
      const keys = answer.exceptions_added.map(exceptionKey);
      expect(keys).toEqual([...keys].sort());
    }));

  it("ignores ambiguous dataset names but applies ids and unique names", () =>
    rolledBack(async (tx) => {
      const conventions = resolve({
        dataset_fields: { owner: { required: true } },
        exceptions: [
          {
            rule: "dataset_fields.owner",
            dataset: "Twin",
            reason: "Ambiguous.",
          },
          { rule: "dataset_fields.owner", dataset: "Sales", reason: "Unique." },
        ],
      });
      const failures = await failuresInBook({ db: tx }, conventions);
      for (const dataset of [id.twin_a, id.twin_b]) {
        expect(failures).toContainEqual({
          rule: "dataset_fields.owner",
          target: { dataset },
        });
      }
      expect(failures).not.toContainEqual({
        rule: "dataset_fields.owner",
        target: { dataset: "Sales" },
      });
      expect(await unusedExceptions({ db: tx }, conventions)).toEqual([
        {
          rule: "dataset_fields.owner",
          target: { dataset: "Twin" },
          reason: "Ambiguous.",
          why: "ambiguous",
        },
      ]);
      const byId = resolve({
        dataset_fields: { owner: { required: true } },
        exceptions: [
          {
            rule: "dataset_fields.owner",
            dataset: id.sales,
            reason: "By id.",
          },
        ],
      });
      expect(await failuresInBook({ db: tx }, byId)).not.toContainEqual({
        rule: "dataset_fields.owner",
        target: { dataset: "Sales" },
      });
      expect(await unusedExceptions({ db: tx }, byId)).toEqual([]);
    }));
});
