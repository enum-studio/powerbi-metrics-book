import { ServiceError } from "../../errors.js";
import {
  type Conventions,
  type CustomFieldSpec,
  METRIC_CHECK_NAMES,
  type MetricCheckName,
  TERM_CHECK_NAMES,
  type TermCheckName,
} from "../conventions/schema.js";

/*
 * The checks the conventions turn on, off or configure. Each reads its rule
 * from the conventions it is given and nothing from code, so a company that
 * changes a rule changes the outcome. Pure: the caller loads the metric, the
 * other labels and the variants. A check answers null when it passes. When
 * it fails it answers the sentence that tells an agent what to fix, with the
 * labels that sentence counts when it counts any.
 */

export type CheckableMetric = {
  name: string;
  label: string;
  name_is_generated: boolean;
  definition: string | null;
  aliases: string[] | null;
  when_to_use: string | null;
  not_the_same_as: string | null;
  grain_and_filters: string | null;
  unit: string | null;
  category_id: string | null;
  custom: Record<string, unknown>;
};

export type CheckableTerm = {
  definition: string | null;
  values: unknown;
  /** A backing column holds categories (text), so the term lists what each value means. */
  categorical: boolean;
  custom: Record<string, unknown>;
};

export type CheckResult = {
  check: string;
  passed: boolean;
  message: string;
  /** The metrics a failing metric_not_the_same_as is about, closest first: a common word can match hundreds, so the message counts them and this lists them. */
  other_labels?: string[];
};
export type MetricCheckContext = {
  conventions: Conventions;
  /** The labels of the other metrics that may share a word of this one's; see wordsComparedWithOtherLabels. */
  other_labels: string[];
  live_base_variants: number;
  /** False for a reader who cannot curate, or on the connector, which never changes the book: a message then states the fact and gives no order. */
  advise: boolean;
  /** Live variants filed `other`: a measure read as time-shifted, with no proof of how. */
  live_other_variants: number;
};
export type TermCheckContext = {
  conventions: Conventions;
  backed_by_columns: number;
};

type MetricCheck = (
  metric: CheckableMetric,
  context: MetricCheckContext,
) => string | { message: string; other_labels: string[] } | null;
type TermCheck = (
  term: CheckableTerm,
  context: TermCheckContext,
) => string | null;

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** How many labels a metric's page names for a failing metric_not_the_same_as; its checks list them all. */
export const LABELS_NAMED = 10;

/** Lower-case words, so number_of_orders and "Number of orders" read alike. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Where `run` starts in `words`, at `from` or later; -1 when it does not. */
function findRun(words: string[], run: string[], from = 0): number {
  if (run.length === 0) return -1;
  for (let at = from; at + run.length <= words.length; at++) {
    if (run.every((word, offset) => words[at + offset] === word)) return at;
  }
  return -1;
}

const holds = (words: string[], phrase: string): boolean =>
  findRun(words, wordsOf(phrase)) !== -1;

const blank = (text: string | null): boolean =>
  text === null || text.trim() === "";

/** A kind ending in an underscore opens the key (total_); one starting with it follows what it counts (_rate). */
function takesKind(words: string[], kind: string): boolean {
  const run = wordsOf(kind);
  if (kind.endsWith("_")) {
    return words.length > run.length && findRun(words, run) === 0;
  }
  return findRun(words, run, 1) !== -1;
}

const metric_name_form: MetricCheck = (metric, { conventions, advise }) => {
  const { kinds } = conventions.naming;
  const problems: string[] = [];
  if (
    conventions.naming.case === "snake_case" &&
    !SNAKE_CASE.test(metric.name)
  ) {
    problems.push(
      `The key ${metric.name} is not snake_case: lower-case words joined by underscores (naming.case).`,
    );
  }
  const words = wordsOf(metric.name);
  if (kinds.length > 0 && !kinds.some((kind) => takesKind(words, kind))) {
    problems.push(
      `The key does not start or end with a kind the conventions name: ${kinds.join(", ")} (naming.kinds).`,
    );
  }
  return problems.length === 0
    ? null
    : `${problems.join(" ")}${advise ? " Rename it." : ""}`;
};

const metric_name_generated: MetricCheck = (metric, { advise }) =>
  metric.name_is_generated
    ? `The sync made the key ${metric.name} from a measure name and nobody has confirmed it.${advise ? " Rename the metric by the conventions, or confirm the key as it is." : ""}`
    : null;

const metric_name_comparison: MetricCheck = (
  metric,
  { conventions, advise },
) => {
  const words = wordsOf(metric.name);
  const found = conventions.naming.forbidden_words.filter((word) =>
    holds(words, word),
  );
  return found.length === 0
    ? null
    : `The key holds ${found.join(", ")}, which the conventions forbid in a key (naming.forbidden_words).${advise ? " Rename it without them, and file a shifted measure as a variant of its metric." : ""}`;
};

const metric_money_qualifier: MetricCheck = (
  metric,
  { conventions, advise },
) => {
  const { required, values, units } = conventions.naming.money_qualifier;
  if (!required || metric.unit === null || !units.includes(metric.unit))
    return null;
  const words = wordsOf(metric.name);
  return values.some((value) => holds(words, value))
    ? null
    : `The key ${metric.name} is in ${metric.unit} but carries none of the qualifiers the conventions require on it: ${values.join(", ")} (naming.money_qualifier).${advise ? " Rename it with one." : ""}`;
};

const metric_qualifier_order: MetricCheck = (
  metric,
  { conventions, advise },
) => {
  const { qualifier_order: order, qualifiers } = conventions.naming;
  const markers = order
    .flatMap((group, rank) =>
      (qualifiers[group] ?? []).map((marker) => ({
        group,
        rank,
        marker,
        run: wordsOf(marker),
      })),
    )
    .sort((a, b) => b.run.length - a.run.length);
  const words = wordsOf(metric.name);
  let previous: (typeof markers)[number] | undefined;
  // A qualifier follows what it qualifies, so the key's first word is never one.
  for (let at = 1; at < words.length; at++) {
    const hit = markers.find((marker) => findRun(words, marker.run, at) === at);
    if (hit === undefined) continue;
    if (previous !== undefined && hit.rank < previous.rank) {
      return `The key puts ${hit.marker} (${hit.group}) after ${previous.marker} (${previous.group}), but the conventions order qualifiers ${order.join(", ")} (naming.qualifier_order).${advise ? ` Rename it with ${hit.marker} before ${previous.marker}.` : ""}`;
    }
    previous = hit;
    at += hit.run.length - 1;
  }
  return null;
};

const metric_fields: MetricCheck = (metric, { conventions }) => {
  const rules = conventions.metric_fields;
  const empty = [
    rules.definition.required && blank(metric.definition) && "definition",
    rules.when_to_use.required && blank(metric.when_to_use) && "when_to_use",
    rules.grain_and_filters.required &&
      blank(metric.grain_and_filters) &&
      "grain_and_filters",
    rules.unit.required && blank(metric.unit) && "unit",
    rules.category.required && metric.category_id === null && "category",
    rules.not_the_same_as.required === true &&
      blank(metric.not_the_same_as) &&
      "not_the_same_as",
  ].filter((field) => field !== false);
  // An empty list of aliases is the reviewed "none" the standard allows.
  const unreviewed = [
    rules.aliases.required && metric.aliases === null && "aliases",
  ].filter((field) => field !== false);
  const problems: string[] = [];
  if (empty.length > 0) problems.push(`Fill in ${empty.join(", ")}.`);
  if (unreviewed.length > 0) {
    problems.push(
      `Review ${unreviewed.join(", ")}: give them, or an empty list when there are none.`,
    );
  }
  const { unit } = metric;
  if (unit !== null && !blank(unit) && !rules.unit.values.includes(unit)) {
    problems.push(
      `The unit ${unit} is not one the conventions name: ${rules.unit.values.join(", ")}.`,
    );
  }
  problems.push(...validateCustomFields(rules.custom, metric.custom));
  return problems.length === 0 ? null : `${problems.join(" ")} (metric_fields)`;
};

/** A content word is any but the words of the kinds, the placed qualifiers and ignore_words. */
const contentWordsUnder = ({ naming, metric_fields }: Conventions) => {
  const { kinds, qualifier_order, qualifiers, money_qualifier } = naming;
  const form = [
    ...kinds,
    ...qualifier_order.flatMap((group) => qualifiers[group] ?? []),
    ...money_qualifier.values,
    ...metric_fields.not_the_same_as.ignore_words,
  ];
  const ignored = new Set(form.flatMap(wordsOf));
  return (label: string) => wordsOf(label).filter((word) => !ignored.has(word));
};

/**
 * The words of the metric's label metric_not_the_same_as looks for in other
 * labels. None when it will not look, so a caller need not read those labels.
 */
export function wordsComparedWithOtherLabels(
  metric: Pick<CheckableMetric, "label" | "not_the_same_as">,
  conventions: Conventions,
): string[] {
  if (
    conventions.checks.off.includes("metric_not_the_same_as") ||
    conventions.metric_fields.not_the_same_as.required !==
      "when_label_shares_a_word" ||
    !blank(metric.not_the_same_as)
  )
    return [];
  return contentWordsUnder(conventions)(metric.label);
}

const metric_not_the_same_as: MetricCheck = (
  metric,
  { conventions, other_labels },
) => {
  const own = new Set(wordsComparedWithOtherLabels(metric, conventions));
  if (own.size === 0) return null;
  const contentWords = contentWordsUnder(conventions);
  const sharing = other_labels
    .map((label) => {
      const words = new Set(contentWords(label));
      const shared = [...words].filter((word) => own.has(word)).length;
      return { label, shared, unshared: words.size - shared };
    })
    .filter(({ shared }) => shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        a.unshared - b.unshared ||
        a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  if (sharing.length === 0) return null;
  const others =
    sharing.length === 1
      ? "Another metric shares"
      : `${String(sharing.length)} other metrics share`;
  return {
    message: `${others} a content word of the label "${metric.label}". Say in not_the_same_as how this metric differs.`,
    other_labels: sharing.map(({ label }) => label),
  };
};

// `other` says no measure computes the metric unshifted, so a metric holding
// only that is as close to a base as the book can know.
const metric_base_variant: MetricCheck = (
  _metric,
  { live_base_variants, live_other_variants },
) =>
  live_base_variants > 0 || live_other_variants > 0
    ? null
    : "The metric has no live base variant: no measure computes it unshifted. File the measure that does under it, or dismiss the metric.";

const hasValues = (values: unknown): boolean =>
  Array.isArray(values)
    ? values.length > 0
    : typeof values === "object" &&
      values !== null &&
      Object.keys(values).length > 0;

const term_fields: TermCheck = (term, { conventions, backed_by_columns }) => {
  const rules = conventions.term_fields;
  const problems: string[] = [];
  if (rules.definition.required && blank(term.definition))
    problems.push("Write its definition.");
  const needsValues =
    rules.values.required === true ||
    (rules.values.required === "when_categorical" &&
      backed_by_columns > 0 &&
      term.categorical);
  if (needsValues && !hasValues(term.values))
    problems.push("List its values, each with what it means.");
  problems.push(...validateCustomFields(rules.custom, term.custom));
  return problems.length === 0 ? null : `${problems.join(" ")} (term_fields)`;
};

/** One function per check, keyed by the name the conventions use for it. */
export const METRIC_CHECKS = {
  metric_name_form,
  metric_name_generated,
  metric_name_comparison,
  metric_money_qualifier,
  metric_qualifier_order,
  metric_fields,
  metric_not_the_same_as,
  metric_base_variant,
} satisfies Record<MetricCheckName, MetricCheck>;

export const TERM_CHECKS = { term_fields } satisfies Record<
  TermCheckName,
  TermCheck
>;

const result = (
  check: string,
  problem: ReturnType<MetricCheck>,
): CheckResult => {
  if (problem === null) return { check, passed: true, message: "Passes." };
  return typeof problem === "string"
    ? { check, passed: false, message: problem }
    : { check, passed: false, ...problem };
};

/** Every metric check the conventions leave on; one in checks.off gives no result. */
export function checkMetric(
  metric: CheckableMetric,
  context: MetricCheckContext,
): CheckResult[] {
  const off = new Set<string>(context.conventions.checks.off);
  return METRIC_CHECK_NAMES.filter((check) => !off.has(check)).map((check) =>
    result(check, METRIC_CHECKS[check](metric, context)),
  );
}

export function checkTerm(
  term: CheckableTerm,
  context: TermCheckContext,
): CheckResult[] {
  const off = new Set<string>(context.conventions.checks.off);
  return TERM_CHECK_NAMES.filter((check) => !off.has(check)).map((check) =>
    result(check, TERM_CHECKS[check](term, context)),
  );
}

/** A calendar date: 2026-02-30 parses, as 2 March, so it must also print back as written. */
function isDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(time) &&
    new Date(time).toISOString().startsWith(value)
  );
}

/** What the field takes, when the value does not fit it; null when it does. */
function mismatch(field: CustomFieldSpec, value: unknown): string | null {
  const choices = field.values ?? [];
  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : "text";
    case "number":
      return Number.isFinite(value) ? null : "a number";
    case "boolean":
      return typeof value === "boolean" ? null : "true or false";
    case "date":
      return typeof value === "string" && isDate(value)
        ? null
        : "a date written YYYY-MM-DD";
    case "choice":
      return typeof value === "string" && choices.includes(value)
        ? null
        : `one of ${choices.join(", ")}`;
  }
}

/** Problems with an element's custom values against the conventions' fields; empty when valid. */
export function validateCustomFields(
  fields: CustomFieldSpec[],
  values: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    const name = `${field.label} (${field.key})`;
    if (value === undefined || value === null || value === "") {
      if (field.required) problems.push(`${name} is required.`);
      continue;
    }
    const expected = mismatch(field, value);
    if (expected !== null) problems.push(`${name} must be ${expected}.`);
  }
  for (const key of Object.keys(values)) {
    if (!fields.some((field) => field.key === key)) {
      problems.push(`${key} is not a custom field the conventions name.`);
    }
  }
  return problems;
}

/**
 * Refuses custom values the conventions do not allow: a key they do not name,
 * or a value of the wrong type. A field they require and the element lacks is
 * left to the checks, because a change to the conventions must not make every
 * existing element unwritable until someone fills the new field in.
 */
export function checkCustom(
  fields: CustomFieldSpec[],
  values: Record<string, unknown>,
): void {
  const problems = validateCustomFields(
    fields.map((field) => ({ ...field, required: false })),
    values,
  );
  if (problems.length > 0) {
    throw new ServiceError(
      "invalid",
      `The custom fields are not valid. ${problems.join(" ")}`,
      { problems },
    );
  }
}
