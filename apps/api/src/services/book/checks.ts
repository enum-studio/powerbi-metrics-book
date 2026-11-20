import { columnTarget } from "../mirror/read.js";
import { ServiceError } from "../../errors.js";
import {
  type Conventions,
  type CustomFieldSpec,
  exceptionKey,
  METRIC_CHECK_NAMES,
  type MetricCheckName,
  TERM_CHECK_NAMES,
  type CheckName,
  type TermCheckName,
} from "../conventions/schema.js";
import { isRuleOff, rulesOfCheck } from "../conventions/rules.js";

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
  name: string;
  definition: string | null;
  values: unknown;
  /** A backing column holds categories (text), so the term lists what each value means. */
  categorical: boolean;
  custom: Record<string, unknown>;
};

export type CheckResult = {
  check: string;
  /** The id of the rule this result is about; a check that applies several rules gives one result for each. */
  rule: string;
  passed: boolean;
  message: string;
  /** The metrics a failing metric_not_the_same_as is about, closest first: a common word can match hundreds, so the message counts them and this lists them. */
  other_labels?: string[];
  /** The reason of the exception the conventions make for this element: it fails the rule, and passes by the exception. */
  exception?: string;
};

/** The element a result or an exception is about: a metric by its key, a term by its name, an element of a dataset by its names. */
export interface CheckTarget {
  metric?: string;
  term?: string;
  dataset?: string;
  table?: string;
  column?: string;
}

/** The reason of each of the conventions' exceptions, by exceptionKey: built once for a run of the checks, and given to each. */
export type ExceptionIndex = ReadonlyMap<string, string>;
export const exceptionIndex = (conventions: Conventions): ExceptionIndex =>
  new Map(
    conventions.exceptions.map((item) => [exceptionKey(item), item.reason]),
  );

export type MetricCheckContext = {
  conventions: Conventions;
  exceptions: ExceptionIndex;
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
  exceptions: ExceptionIndex;
  backed_by_columns: number;
};

/** One rule a check found broken: its id, and the sentence that tells what to fix. */
type Finding = { rule: string; message: string; other_labels?: string[] };
type MetricCheck = (
  metric: CheckableMetric,
  context: MetricCheckContext,
) => Finding[];
type TermCheck = (term: CheckableTerm, context: TermCheckContext) => Finding[];

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
  const rename = advise ? " Rename it." : "";
  const found: Finding[] = [];
  if (
    conventions.naming.case === "snake_case" &&
    !SNAKE_CASE.test(metric.name)
  ) {
    found.push({
      rule: "naming.case",
      message: `The key ${metric.name} is not snake_case: lower-case words joined by underscores (naming.case).${rename}`,
    });
  }
  const words = wordsOf(metric.name);
  if (kinds.length > 0 && !kinds.some((kind) => takesKind(words, kind))) {
    found.push({
      rule: "naming.kinds",
      message: `The key does not start or end with a kind the conventions name: ${kinds.join(", ")} (naming.kinds).${rename}`,
    });
  }
  return found;
};

const metric_name_generated: MetricCheck = (metric, { advise }) =>
  metric.name_is_generated
    ? [
        {
          rule: "metric_name_generated",
          message: `The sync made the key ${metric.name} from a measure name and nobody has confirmed it.${advise ? " Rename the metric by the conventions, or confirm the key as it is." : ""}`,
        },
      ]
    : [];

const metric_name_comparison: MetricCheck = (
  metric,
  { conventions, advise },
) => {
  const words = wordsOf(metric.name);
  const found = conventions.naming.forbidden_words.filter((word) =>
    holds(words, word),
  );
  return found.length === 0
    ? []
    : [
        {
          rule: "naming.forbidden_words",
          message: `The key holds ${found.join(", ")}, which the conventions forbid in a key (naming.forbidden_words).${advise ? " Rename it without them, and file a shifted measure as a variant of its metric." : ""}`,
        },
      ];
};

const metric_money_qualifier: MetricCheck = (
  metric,
  { conventions, advise },
) => {
  const { required, values, units } = conventions.naming.money_qualifier;
  if (!required || metric.unit === null || !units.includes(metric.unit))
    return [];
  const words = wordsOf(metric.name);
  return values.some((value) => holds(words, value))
    ? []
    : [
        {
          rule: "naming.money_qualifier",
          message: `The key ${metric.name} is in ${metric.unit} but carries none of the qualifiers the conventions require on it: ${values.join(", ")} (naming.money_qualifier).${advise ? " Rename it with one." : ""}`,
        },
      ];
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
      return [
        {
          rule: "naming.qualifier_order",
          message: `The key puts ${hit.marker} (${hit.group}) after ${previous.marker} (${previous.group}), but the conventions order qualifiers ${order.join(", ")} (naming.qualifier_order).${advise ? ` Rename it with ${hit.marker} before ${previous.marker}.` : ""}`,
        },
      ];
    }
    previous = hit;
    at += hit.run.length - 1;
  }
  return [];
};

const metric_fields: MetricCheck = (metric, { conventions }) => {
  const rules = conventions.metric_fields;
  const found: Finding[] = [];
  const add = (field: string, message: string) =>
    found.push({ rule: `metric_fields.${field}`, message });
  const empty: [string, boolean][] = [
    ["definition", rules.definition.required && blank(metric.definition)],
    ["when_to_use", rules.when_to_use.required && blank(metric.when_to_use)],
    [
      "grain_and_filters",
      rules.grain_and_filters.required && blank(metric.grain_and_filters),
    ],
    ["unit", rules.unit.required && blank(metric.unit)],
    ["category", rules.category.required && metric.category_id === null],
    [
      "not_the_same_as",
      rules.not_the_same_as.required === true && blank(metric.not_the_same_as),
    ],
  ];
  for (const [field, missing] of empty) {
    if (missing) add(field, `Fill in ${field}.`);
  }
  // An empty list of aliases is the reviewed "none" the standard allows.
  if (rules.aliases.required && metric.aliases === null) {
    add(
      "aliases",
      "Review aliases: give them, or an empty list when there are none.",
    );
  }
  const { unit } = metric;
  if (unit !== null && !blank(unit) && !rules.unit.values.includes(unit)) {
    add(
      "unit",
      `The unit ${unit} is not one the conventions name: ${rules.unit.values.join(", ")}.`,
    );
  }
  const custom = validateCustomFields(rules.custom, metric.custom);
  if (custom.length > 0) add("custom", custom.join(" "));
  return found;
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
    conventions.metric_fields.not_the_same_as.required !==
      "when_label_shares_a_word" ||
    !blank(metric.not_the_same_as) ||
    rulesOfCheck("metric_not_the_same_as").some((rule) =>
      isRuleOff(rule, conventions),
    )
  )
    return [];
  return contentWordsUnder(conventions)(metric.label);
}

const metric_not_the_same_as: MetricCheck = (
  metric,
  { conventions, other_labels },
) => {
  const own = new Set(wordsComparedWithOtherLabels(metric, conventions));
  if (own.size === 0) return [];
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
  if (sharing.length === 0) return [];
  const others =
    sharing.length === 1
      ? "Another metric shares"
      : `${String(sharing.length)} other metrics share`;
  return [
    {
      rule: "metric_fields.not_the_same_as",
      message: `${others} a content word of the label "${metric.label}". Say in not_the_same_as how this metric differs.`,
      other_labels: sharing.map(({ label }) => label),
    },
  ];
};

// `other` says no measure computes the metric unshifted, so a metric holding
// only that is as close to a base as the book can know.
const metric_base_variant: MetricCheck = (
  _metric,
  { live_base_variants, live_other_variants },
) =>
  live_base_variants > 0 || live_other_variants > 0
    ? []
    : [
        {
          rule: "metric_base_variant",
          message:
            "The metric has no live base variant: no measure computes it unshifted. File the measure that does under it, or dismiss the metric.",
        },
      ];

const hasValues = (values: unknown): boolean =>
  Array.isArray(values)
    ? values.length > 0
    : typeof values === "object" &&
      values !== null &&
      Object.keys(values).length > 0;

const term_fields: TermCheck = (term, { conventions, backed_by_columns }) => {
  const rules = conventions.term_fields;
  const found: Finding[] = [];
  if (rules.definition.required && blank(term.definition)) {
    found.push({
      rule: "term_fields.definition",
      message: "Write its definition.",
    });
  }
  const needsValues =
    rules.values.required === true ||
    (rules.values.required === "when_categorical" &&
      backed_by_columns > 0 &&
      term.categorical);
  if (needsValues && !hasValues(term.values)) {
    found.push({
      rule: "term_fields.values",
      message: "List its values, each with what it means.",
    });
  }
  const custom = validateCustomFields(rules.custom, term.custom);
  if (custom.length > 0) {
    found.push({ rule: "term_fields.custom", message: custom.join(" ") });
  }
  return found;
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

/**
 * One result for each rule the check applies, failing for those it found
 * broken. A finding under a rule the check is not filed under (metric_fields
 * asking for not_the_same_as) is a result too.
 */
function resultsOf(check: CheckName, found: Finding[]): CheckResult[] {
  const results: CheckResult[] = rulesOfCheck(check).map(({ id }) => {
    const finding = found.find((one) => one.rule === id);
    return finding === undefined
      ? { check, rule: id, passed: true, message: "Passes." }
      : { check, passed: false, ...finding };
  });
  const filed = new Set(results.map(({ rule }) => rule));
  for (const finding of found) {
    if (!filed.has(finding.rule)) {
      results.push({ check, passed: false, ...finding });
    }
  }
  return results;
}

/**
 * The results `off` leaves, by the rule's id or by the check that gave it,
 * each failure an exception covers passing under that exception.
 */
function underConventions(
  results: CheckResult[],
  context: Pick<MetricCheckContext, "conventions" | "exceptions">,
  target: CheckTarget,
): CheckResult[] {
  const { conventions, exceptions } = context;
  const off = new Set<string>(conventions.off);
  return results
    .filter(({ check, rule }) => !off.has(check) && !off.has(rule))
    .map((result) => {
      const reason = result.passed
        ? undefined
        : exceptions.get(exceptionKey({ rule: result.rule, ...target }));
      return reason === undefined
        ? result
        : { ...result, passed: true, exception: reason };
    });
}

/** Every metric check the conventions leave on; a check or a rule in `off` gives no result. */
export function checkMetric(
  metric: CheckableMetric,
  context: MetricCheckContext,
): CheckResult[] {
  const off = new Set<string>(context.conventions.off);
  // Under any other setting metric_fields owns the rule, so it is told once.
  const sharesAWord =
    context.conventions.metric_fields.not_the_same_as.required ===
    "when_label_shares_a_word";
  return underConventions(
    METRIC_CHECK_NAMES.filter(
      (check) =>
        !off.has(check) && (sharesAWord || check !== "metric_not_the_same_as"),
    ).flatMap((check) =>
      resultsOf(check, METRIC_CHECKS[check](metric, context)),
    ),
    context,
    { metric: metric.name },
  );
}

export function checkTerm(
  term: CheckableTerm,
  context: TermCheckContext,
): CheckResult[] {
  const off = new Set<string>(context.conventions.off);
  return underConventions(
    TERM_CHECK_NAMES.filter((check) => !off.has(check)).flatMap((check) =>
      resultsOf(check, TERM_CHECKS[check](term, context)),
    ),
    context,
    { term: term.name },
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

/** Facts and documentation read in bulk by the whole-book runner. */
export type CheckableElement = {
  name: string;
  dataset: string;
  description: string | null;
  custom: Record<string, unknown>;
} & (
  | {
      kind: "dataset";
      when_to_use?: string | null;
      owner?: string | null;
      freshness?: string | null;
      caveats?: string | null;
    }
  | {
      kind: "table";
      is_hidden?: boolean;
      table_kind: "fact" | "dimension" | "date" | "measures" | "standalone";
      grain_and_filters?: string | null;
      caveats?: string | null;
    }
  | {
      kind: "column";
      table: string;
      is_hidden: boolean;
      data_type: string | null;
      is_key: boolean;
      has_term: boolean;
      unit?: string | null;
      blank_means?: string | null;
    }
);

export function checkElement(
  element: CheckableElement,
  context: Pick<MetricCheckContext, "conventions" | "exceptions">,
  target = elementTarget(element),
): CheckResult[] {
  const check = `${element.kind}_fields` as const;
  const rules = context.conventions[check];
  const eligible =
    element.kind === "table"
      ? !element.is_hidden &&
        element.table_kind !== "date" &&
        element.table_kind !== "measures"
      : element.kind !== "column" || !element.is_hidden;
  const needs = (required: boolean | string): boolean =>
    eligible &&
    (required === true ||
      (required === "when_fact" &&
        element.kind === "table" &&
        element.table_kind === "fact") ||
      (required === "when_visible_and_no_term" &&
        element.kind === "column" &&
        !element.has_term) ||
      (required === "when_numeric" &&
        element.kind === "column" &&
        !element.is_key &&
        [
          "int64",
          "int32",
          "int16",
          "integer",
          "double",
          "decimal",
          "single",
          "currency",
        ].includes(element.data_type?.toLowerCase() ?? "")));
  const found: Finding[] = [];
  const field = (
    key: string,
    required: boolean | string,
    value: string | null | undefined,
    message: string,
  ) => {
    if (needs(required) && blank(value ?? null))
      found.push({ rule: `${check}.${key}`, message });
  };
  field(
    "definition",
    rules.definition.required,
    element.description,
    `Write the definition of this ${element.kind}.`,
  );
  if (element.kind === "dataset") {
    const fields = context.conventions.dataset_fields;
    field(
      "when_to_use",
      fields.when_to_use.required,
      element.when_to_use,
      "Write when to use this dataset.",
    );
    field(
      "owner",
      fields.owner.required,
      element.owner,
      "Write who owns this dataset.",
    );
    field(
      "freshness",
      fields.freshness.required,
      element.freshness,
      "Write how fresh this dataset is.",
    );
    field(
      "caveats",
      fields.caveats.required,
      element.caveats,
      "Write the caveats of this dataset.",
    );
  } else if (element.kind === "table") {
    const fields = context.conventions.table_fields;
    field(
      "grain_and_filters",
      fields.grain_and_filters.required,
      element.grain_and_filters,
      "Write the grain and filters of this table.",
    );
    field(
      "caveats",
      fields.caveats.required,
      element.caveats,
      "Write the caveats of this table.",
    );
  } else {
    const fields = context.conventions.column_fields;
    field(
      "unit",
      fields.unit.required,
      element.unit,
      "Write the unit of this column.",
    );
    field(
      "blank_means",
      fields.blank_means.required,
      element.blank_means,
      "Write what a blank means in this column.",
    );
  }
  const custom = eligible
    ? validateCustomFields(
        rules.custom.map((spec) => ({
          ...spec,
          required: spec.required && needs(rules.definition.required),
        })),
        element.custom,
      )
    : [];
  if (custom.length > 0)
    found.push({ rule: `${check}.custom`, message: custom.join(" ") });
  return underConventions(resultsOf(check, found), context, target);
}

export function elementTarget(element: CheckableElement): CheckTarget {
  return element.kind === "column"
    ? {
        dataset: element.dataset,
        column: columnTarget(element.table, element.name),
      }
    : element.kind === "table"
      ? { dataset: element.dataset, table: element.name }
      : { dataset: element.dataset };
}
