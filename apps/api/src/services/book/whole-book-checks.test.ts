import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { asPerson } from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { metric, term } from "../../db/schema/book.js";
import * as schema from "../../db/schema/index.js";
import { resolve } from "../conventions/store.js";
import { METRICS, TERMS } from "../sample/book.js";
import { metricChecks } from "./metrics.js";
import { failuresInBook, unusedExceptions } from "./whole-book-checks.js";

afterAll(closeTestPools);

const statements: string[] = [];
const logged = drizzle({
  client: testPool("api_rw"),
  schema,
  logger: { logQuery: (query) => statements.push(query) },
});

/** The work runs in a transaction that is rolled back, each statement it sends counted. */
const rolledBack = (work: (tx: Db) => Promise<void>) =>
  expect(
    logged.transaction(async (tx) => {
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
