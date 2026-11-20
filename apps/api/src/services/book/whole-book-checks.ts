import { leavesOutPiiEnds, modelKinds } from "../mirror/read.js";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  not,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import { metric, term, termColumn } from "../../db/schema/book.js";
import {
  powerbiColumn,
  powerbiDataset,
  powerbiTable,
  powerbiMeasure,
  powerbiRelationship,
} from "../../db/schema/mirror.js";
import { piiColumn, piiMeasure } from "../pii/rules.js";
import { RULE_TARGETS, RULES } from "../conventions/rules.js";
import { type Conventions, exceptionKey } from "../conventions/schema.js";
import {
  type CheckResult,
  type CheckTarget,
  checkMetric,
  checkElement,
  elementTarget,
  type CheckableElement,
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
  why: "no_such_target" | "passes" | "ambiguous";
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

const targetsOf = (
  kind: (typeof RULE_TARGETS)[number],
  rules?: ReadonlySet<string>,
) =>
  RULES.some(
    (rule) =>
      rule.target === kind && (rules === undefined || rules.has(rule.id)),
  );

/** Every failing result in the book under `conventions`, exceptions applied, optionally only for `rules`. Metrics, terms, datasets, tables and columns. */
export async function failuresInBook(
  deps: Deps,
  conventions: Conventions,
  rules?: ReadonlySet<string>,
): Promise<Failure[]> {
  const run: Run = { conventions, exceptions: exceptionIndex(conventions) };
  const checked = [
    ...(targetsOf("metric", rules) ? await checkedMetrics(deps, run) : []),
    ...(targetsOf("term", rules) ? await checkedTerms(deps, run) : []),
    ...((["dataset", "table", "column"] as const).some((kind) =>
      targetsOf(kind, rules),
    )
      ? await checkedElements(deps, run)
      : []),
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
  checkedElementsInRun?: CheckedElement[],
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
  const elements = exceptions.some(({ target }) => target.dataset !== undefined)
    ? (checkedElementsInRun ?? (await checkedElements(deps, run)))
    : [];
  const checked = [
    ...(metrics.length > 0 ? await checkedMetrics(deps, run, metrics) : []),
    ...(terms.length > 0 ? await checkedTerms(deps, run, terms) : []),
    ...elements,
  ];
  const byTarget = new Map(
    checked.map((each) => [exceptionKey(each.target), each]),
  );
  return exceptions.flatMap(({ rule, reason, target }): UnusedException[] => {
    const datasets = elements.filter((each) => each.kind === "dataset");
    const named = datasets.filter((each) => each.name === target.dataset);
    const dataset = datasets.find((each) => each.id === target.dataset);
    if (dataset === undefined && named.length > 1)
      return [{ rule, target, reason, why: "ambiguous" }];
    const resolved = dataset ?? named[0];
    const lookup =
      resolved === undefined ? target : { ...target, ...resolved.target };
    const found = byTarget.get(exceptionKey(lookup));
    if (found === undefined)
      return [{ rule, target, reason, why: "no_such_target" }];
    const result = found.results.find((each) => each.rule === rule);
    return result?.exception === undefined
      ? [{ rule, target, reason, why: "passes" }]
      : [];
  });
}

export type CheckedElement = Checked & {
  kind: "dataset" | "table" | "column";
  id: string;
  name: string;
  dataset: string;
  dataset_id: string;
  table?: string;
};

/** Six bulk reads for the selected datasets, independent of their element count. */
export async function checkedElements(
  { db }: Deps,
  run: Run,
  allowed?: SQL,
  hidesPii = false,
): Promise<CheckedElement[]> {
  const live = await db
    .select({ row: powerbiDataset, allowed: allowed ?? sql<boolean>`true` })
    .from(powerbiDataset)
    .where(isNull(powerbiDataset.removed_at));
  const names = new Map<string, number>();
  for (const { row } of live)
    names.set(row.name, (names.get(row.name) ?? 0) + 1);
  const targets = new Map<string, string>();
  for (const { row } of live) {
    const unique = names.get(row.name) === 1;
    targets.set(row.id, unique ? row.name : row.id);
    if (unique) targets.set(row.name, row.name);
  }
  const exceptions = new Map(
    run.conventions.exceptions.flatMap((item) => {
      if (item.dataset === undefined) return [];
      const dataset = targets.get(item.dataset);
      return dataset === undefined
        ? []
        : [[exceptionKey({ ...item, dataset }), item.reason] as const];
    }),
  );
  const datasets = live.filter((each) => each.allowed).map((each) => each.row);
  if (datasets.length === 0) return [];
  const ids = datasets.map((row) => row.id);
  const [tables, columns, relationships, measures, links] = await Promise.all([
    db
      .select()
      .from(powerbiTable)
      .where(
        and(
          inArray(powerbiTable.dataset_id, ids),
          isNull(powerbiTable.removed_at),
        ),
      ),
    db
      .select({ row: powerbiColumn })
      .from(powerbiColumn)
      .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
      .where(
        and(
          inArray(powerbiColumn.dataset_id, ids),
          isNull(powerbiColumn.removed_at),
          isNull(powerbiTable.removed_at),
          hidesPii ? not(piiColumn(powerbiColumn, powerbiTable)) : undefined,
        ),
      ),
    db
      .select()
      .from(powerbiRelationship)
      .where(
        and(
          inArray(powerbiRelationship.dataset_id, ids),
          isNull(powerbiRelationship.removed_at),
          hidesPii ? leavesOutPiiEnds() : undefined,
        ),
      ),
    db
      .select({ table_id: powerbiMeasure.table_id })
      .from(powerbiMeasure)
      .where(
        and(
          inArray(powerbiMeasure.dataset_id, ids),
          isNull(powerbiMeasure.removed_at),
          hidesPii ? not(piiMeasure(powerbiMeasure)) : undefined,
        ),
      ),
    db
      .select({ column_id: termColumn.column_id })
      .from(termColumn)
      .innerJoin(powerbiColumn, eq(powerbiColumn.id, termColumn.column_id))
      .where(inArray(powerbiColumn.dataset_id, ids)),
  ]);
  const tablesByDataset = Map.groupBy(tables, (row) => row.dataset_id);
  const columnsByTable = Map.groupBy(columns, ({ row }) => row.table_id);
  const relationshipsByDataset = Map.groupBy(
    relationships,
    (row) => row.dataset_id,
  );
  const measuresByTable = Map.groupBy(measures, (row) => row.table_id);
  const backed = new Set(links.map((row) => row.column_id));
  const result: CheckedElement[] = [];
  const add = (id: string, datasetId: string, element: CheckableElement) => {
    const dataset = targets.get(datasetId) ?? datasetId;
    const named = { ...element, dataset };
    const target = elementTarget(named);
    result.push({
      kind: element.kind,
      id,
      name: element.name,
      dataset: element.dataset,
      dataset_id: datasetId,
      ...(element.kind === "column" ? { table: element.table } : {}),
      target,
      results: checkElement(named, { ...run, exceptions }, target),
    });
  };
  for (const dataset of datasets) {
    add(dataset.id, dataset.id, {
      ...dataset,
      kind: "dataset",
      dataset: dataset.name,
    });
    const ownTables = tablesByDataset.get(dataset.id) ?? [];
    const modelColumns = ownTables.flatMap((table) =>
      (columnsByTable.get(table.id) ?? []).map(({ row }) => ({
        ...row,
        table: table.name,
      })),
    );
    const { tableKind, ends, columnKey } = modelKinds(
      modelColumns,
      relationshipsByDataset.get(dataset.id) ?? [],
    );
    for (const table of ownTables) {
      const own = columnsByTable.get(table.id) ?? [];
      const table_kind = tableKind({
        name: table.name,
        column_count: own.length,
        measure_count: measuresByTable.get(table.id)?.length ?? 0,
      });
      add(table.id, dataset.id, {
        ...table,
        kind: "table",
        dataset: dataset.name,
        table_kind,
      });
      for (const { row } of own) {
        add(row.id, dataset.id, {
          ...row,
          kind: "column",
          dataset: dataset.name,
          table: table.name,
          is_key: ends.has(columnKey(table.name, row.name)),
          is_hidden: table.is_hidden || row.is_hidden,
          has_term: backed.has(row.id),
        });
      }
    }
  }
  return result;
}
