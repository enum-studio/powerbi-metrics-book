import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import { metric, term, termColumn } from "../../db/schema/book.js";
import { powerbiColumn } from "../../db/schema/mirror.js";
import { RULE_TARGETS, RULES } from "../conventions/rules.js";
import { type Conventions, exceptionKey } from "../conventions/schema.js";
import {
  type CheckResult,
  type CheckTarget,
  checkMetric,
  checkTerm,
  type ExceptionIndex,
  exceptionIndex,
  wordsComparedWithOtherLabels,
} from "./checks.js";
import { liveVariants } from "./metrics.js";

/*
 * The checks over the whole book, as the system: every metric not dismissed
 * and every term, read in a few queries, as a book holds thousands of drafts.
 */

export type { CheckTarget };
type Deps = Pick<AppDeps, "db">;
/** The conventions a run checks under, with their exceptions indexed once for the run. */
type Run = { conventions: Conventions; exceptions: ExceptionIndex };

export interface Failure {
  rule: string;
  target: CheckTarget;
}

export interface UnusedException {
  rule: string;
  target: CheckTarget;
  reason: string;
  why: "no_such_target" | "passes";
}

type Checked = { target: CheckTarget; results: CheckResult[] };

/**
 * For each metric's own content words, the label of one other metric that
 * shares one, among `labels`. A runner keeps only whether a result fails, and
 * one such label fails metric_not_the_same_as as the whole list would, so no
 * metric is compared with every other.
 */
function sharingLabels(
  labels: readonly { id: string; label: string }[],
  conventions: Conventions,
): (id: string, words: string[]) => string[] {
  const byWord = new Map<string, { id: string; label: string }[]>();
  for (const other of labels) {
    const words = wordsComparedWithOtherLabels(
      { label: other.label, not_the_same_as: null },
      conventions,
    );
    for (const word of new Set(words)) {
      const holders = byWord.get(word) ?? [];
      // Two are enough: one of them is not the metric asking.
      if (holders.length < 2) holders.push(other);
      byWord.set(word, holders);
    }
  }
  return (id, words) => {
    for (const word of words) {
      const other = byWord.get(word)?.find((holder) => holder.id !== id);
      if (other !== undefined) return [other.label];
    }
    return [];
  };
}

async function checkedMetrics(
  { db }: Deps,
  run: Run,
  names?: readonly string[],
): Promise<Checked[]> {
  const { conventions } = run;
  const named =
    names === undefined ? undefined : inArray(metric.name, [...names]);
  const which = and(isNull(metric.dismissed_at), named);
  const rows = await db.select().from(metric).where(which);
  if (rows.length === 0) return [];
  const bases = await liveVariants(db, which);
  const variants = new Map(bases.map((row) => [row.metric_id, row]));
  const needsLabels = rows.some(
    (row) => wordsComparedWithOtherLabels(row, conventions).length > 0,
  );
  // The whole book's rows hold every label; named metrics are compared with all of them.
  const sharing = needsLabels
    ? sharingLabels(
        names === undefined
          ? rows
          : await db
              .select({ id: metric.id, label: metric.label })
              .from(metric)
              .where(isNull(metric.dismissed_at)),
        conventions,
      )
    : () => [];
  return rows.map((row) => {
    const found = variants.get(row.id);
    const other = found?.other ?? 0;
    return {
      target: { metric: row.name },
      results: checkMetric(row, {
        ...run,
        other_labels: sharing(
          row.id,
          wordsComparedWithOtherLabels(row, conventions),
        ),
        live_base_variants: (found?.live ?? 0) - other,
        live_other_variants: other,
        advise: false,
      }),
    };
  });
}

async function checkedTerms(
  { db }: Deps,
  run: Run,
  names?: readonly string[],
): Promise<Checked[]> {
  const named =
    names === undefined ? undefined : inArray(term.name, [...names]);
  const rows = await db.select().from(term).where(named);
  if (rows.length === 0) return [];
  const backing = await db
    .select({
      term_id: termColumn.term_id,
      columns: count(),
      categorical:
        sql<boolean>`bool_or(lower(${powerbiColumn.data_type}) = 'string')`.mapWith(
          Boolean,
        ),
    })
    .from(termColumn)
    .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
    .innerJoin(term, eq(term.id, termColumn.term_id))
    .where(and(isNull(powerbiColumn.removed_at), named))
    .groupBy(termColumn.term_id);
  const backed = new Map(backing.map((row) => [row.term_id, row]));
  return rows.map((row) => {
    const found = backed.get(row.id);
    return {
      target: { term: row.name },
      results: checkTerm(
        { ...row, categorical: found?.categorical ?? false },
        { ...run, backed_by_columns: found?.columns ?? 0 },
      ),
    };
  });
}

const targetsOf = (kind: "metric" | "term", rules?: ReadonlySet<string>) =>
  RULES.some(
    (rule) =>
      rule.target === kind && (rules === undefined || rules.has(rule.id)),
  );

/** Every failing result in the book under `conventions`, exceptions applied, optionally only for `rules`. Metrics and terms here; the element checks issue adds datasets, tables and columns. */
export async function failuresInBook(
  deps: Deps,
  conventions: Conventions,
  rules?: ReadonlySet<string>,
): Promise<Failure[]> {
  const run: Run = { conventions, exceptions: exceptionIndex(conventions) };
  const checked = [
    ...(targetsOf("metric", rules) ? await checkedMetrics(deps, run) : []),
    ...(targetsOf("term", rules) ? await checkedTerms(deps, run) : []),
  ];
  return checked.flatMap(({ target, results }) =>
    results
      .filter(
        (result) =>
          !result.passed && (rules === undefined || rules.has(result.rule)),
      )
      .map((result) => ({ rule: result.rule, target })),
  );
}

/** Whether `target` holds every value `only` gives. */
const within = (target: CheckTarget, only: CheckTarget): boolean =>
  RULE_TARGETS.every(
    (key) => only[key] === undefined || target[key] === only[key],
  );

/** An exception is unused when its target does not exist, or its target passes the rule without it. */
export async function unusedExceptions(
  deps: Deps,
  conventions: Conventions,
  only?: CheckTarget,
): Promise<UnusedException[]> {
  const run: Run = { conventions, exceptions: exceptionIndex(conventions) };
  const exceptions = conventions.exceptions
    .map(({ rule, reason, ...target }) => ({ rule, reason, target }))
    .filter(({ target }) => only === undefined || within(target, only));
  const namesOf = (kind: "metric" | "term") => [
    ...new Set(exceptions.flatMap(({ target }) => target[kind] ?? [])),
  ];
  const metrics = namesOf("metric");
  const terms = namesOf("term");
  const checked = [
    ...(metrics.length > 0 ? await checkedMetrics(deps, run, metrics) : []),
    ...(terms.length > 0 ? await checkedTerms(deps, run, terms) : []),
  ];
  const byTarget = new Map(
    checked.map((each) => [exceptionKey(each.target), each]),
  );
  return exceptions.flatMap(({ rule, reason, target }): UnusedException[] => {
    const found = byTarget.get(exceptionKey(target));
    if (found === undefined)
      return [{ rule, target, reason, why: "no_such_target" }];
    const result = found.results.find((each) => each.rule === rule);
    return result?.exception === undefined
      ? [{ rule, target, reason, why: "passes" }]
      : [];
  });
}
