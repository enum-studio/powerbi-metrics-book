import { and, eq, inArray, isNull, not } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import {
  powerbiDataset,
  powerbiTable,
  powerbiColumn,
} from "../../db/schema/mirror.js";
import { metric } from "../../db/schema/book.js";
import { BOOK, requireCurator } from "../book/changes.js";
import { visibleMetric } from "../mirror/read.js";
import { resolveMetric } from "../book/metrics.js";
import { exceptionIndex } from "../book/checks.js";
import {
  checkedElements,
  unusedExceptions,
} from "../book/whole-book-checks.js";
import { piiColumn, readsPii } from "../pii/rules.js";
import { type ApplyInput, applyConventions } from "./apply.js";
import { FIXED_RULES, isRuleOff, RULES, valueAt } from "./rules.js";
import {
  exceptionKey,
  columnTarget,
  type Conventions,
  type CustomFieldSpec,
} from "./schema.js";
import {
  conventionsInForce,
  currentConventions,
  diffConventions,
  listVersions,
  resolve,
  setConventions,
} from "./store.js";

/** The rules as agents get them: everything in the conventions but the guide. */
export type Rules = Omit<Conventions, "guide">;

const words = (items: string[]) => items.join(", ");

const FIELD_TYPES = {
  text: "text",
  number: "a number",
  boolean: "true or false",
  date: "a date written YYYY-MM-DD",
  choice: "one of the listed values",
};

function customFieldsIn(subject: string, fields: CustomFieldSpec[]): string[] {
  return fields.map((field) => {
    const values = field.values === undefined ? "" : `: ${words(field.values)}`;
    return `${subject} have the custom field ${field.key} (${field.label}), ${FIELD_TYPES[field.type]}${values}; ${field.required ? "required" : "optional"}.`;
  });
}

/**
 * What the rules say, in plain sentences, generated from them so it never
 * drifts from them. A rule that is off or empty has no sentence.
 */
export function summariseRules(rules: Rules): string[] {
  const { naming, metric_fields, term_fields, variants, drafting, trust } =
    rules;
  const metricRules = [
    "definition",
    "aliases",
    "when_to_use",
    "grain_and_filters",
    "unit",
    "category",
  ] as const;
  const needed = metricRules.filter((name) => metric_fields[name].required);
  const { not_the_same_as: differs } = metric_fields;
  const { money_qualifier: money } = naming;
  const { axes } = variants;
  const currency = axes.currency.values;
  const { skip } = drafting;
  const skipped = [
    skip.hidden_measures && "hidden measures",
    skip.display_folders.length > 0 &&
      `measures in the display folders ${words(skip.display_folders)}`,
    skip.tables.length > 0 && `measures in the tables ${words(skip.tables)}`,
    skip.name_prefixes.length > 0 &&
      `measures whose name starts with ${words(skip.name_prefixes)} (case-insensitive)`,
    skip.names.length > 0 &&
      `measures named ${words(skip.names)} (case-insensitive)`,
  ].filter((part) => part !== false);
  return [
    naming.case === "snake_case" &&
      "A metric key is snake_case: lowercase words joined by underscores.",
    naming.kinds.length > 0 &&
      `A metric key starts or ends with a kind: ${words(naming.kinds)}. A kind with a trailing underscore opens the key; one with a leading underscore closes it.`,
    naming.forbidden_words.length > 0 &&
      `A metric key never holds these words: ${words(naming.forbidden_words)}. A shifted measure is a variant of its metric, not a metric.`,
    money.required &&
      money.values.length > 0 &&
      `A metric in ${words(money.units)} carries one of ${words(money.values)} in its key.`,
    naming.qualifier_order.length > 0 &&
      `Qualifiers follow this order: ${naming.qualifier_order
        .map((group) => `${group} (${words(naming.qualifiers[group] ?? [])})`)
        .join(", ")}.`,
    naming.label === "sentence_case" &&
      "A metric's label is its key in words, in sentence case.",
    needed.length > 0 && `A metric needs these fields: ${words(needed)}.`,
    differs.required === "when_label_shares_a_word" &&
      "not_the_same_as is needed when another metric's label shares a content word with this one's.",
    differs.required === true && "A metric needs not_the_same_as.",
    metric_fields.unit.values.length > 0 &&
      `A metric's unit is one of: ${words(metric_fields.unit.values)}.`,
    ...customFieldsIn("Metrics", metric_fields.custom),
    term_fields.definition.required && "A term needs a definition.",
    term_fields.values.required === "when_categorical" &&
      "A dimension term on a text column lists its values, each with what it means.",
    term_fields.values.required === true &&
      "A term lists its values, each with what it means.",
    ...customFieldsIn("Terms", term_fields.custom),
    ...customFieldsIn("Datasets", rules.dataset_fields.custom),
    ...customFieldsIn("Tables", rules.table_fields.custom),
    ...customFieldsIn("Columns", rules.column_fields.custom),
    `A variant differs from its metric on its period (${words(axes.period.values)}), its comparison (${words(axes.comparison.values)}) and its currency (${typeof currency === "string" ? "an ISO 4217 code, or local" : words(currency)}).`,
    ...axes.custom.map(
      (axis) => `A variant also differs on ${axis.key}: ${words(axis.values)}.`,
    ),
    drafting.group_by_fingerprint &&
      "The sync groups measures with the same calculation under one draft metric.",
    drafting.recognise_time_intelligence &&
      "The sync files time-intelligence measures (last year, year to date) as variants of their base measure's metric.",
    drafting.recognise_time_intelligence &&
      drafting.recognise_blank_as_zero &&
      "It counts a shift or comparison that shows 0 where the calculation is blank as that shift, and says so in the variant's note.",
    skipped.length > 0 && `The sync drafts nothing from: ${words(skipped)}.`,
    ...drafting.dismiss.map(
      (rule) =>
        `A measure whose name ${"prefix" in rule ? `starts with ${rule.prefix}` : `equals ${rule.name}`} (case-insensitive) is drafted as dismissed: ${rule.reason}`,
    ),
    trust.agent_verify_requires === "all_checks"
      ? "An agent verifies a metric once every check that is on passes."
      : `An agent verifies a metric once these checks pass: ${words(trust.agent_verify_requires)}.`,
    trust.human_verify_from === "browser"
      ? "Only a person in a browser session approves a metric."
      : "A person approves a metric from the browser, the CLI or the API.",
    rules.off.length > 0 &&
      `These rules and checks are off: ${words(rules.off)}.`,
    rules.exceptions.length > 0 &&
      `${String(rules.exceptions.length)} ${rules.exceptions.length === 1 ? "exception lets an element" : "exceptions let elements"} keep failing a rule; an element's checks show its exception and the reason.`,
  ].filter((line) => line !== false);
}

/** The metrics among `names` that exist and the caller may not see, whose names an answer leaves out. */
async function hiddenMetrics(
  context: ServiceContext,
  names: string[],
): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const allowed = await context.access.describableDatasets(context.principal);
  const hidesPii = !(await readsPii(context));
  const rows = await context.db
    .select({ name: metric.name })
    .from(metric)
    .where(
      and(
        inArray(metric.name, names),
        not(visibleMetric(context.db, allowed, hidesPii)),
      ),
    );
  return new Set(rows.map((row) => row.name));
}

/** Exceptions are visible only through a live target and its describable dataset, named by its name or its id. */
export async function visibleExceptions(
  context: ServiceContext,
  exceptions: Conventions["exceptions"],
): Promise<Conventions["exceptions"]> {
  const metrics = new Set(exceptions.flatMap((item) => item.metric ?? []));
  const hidden = await hiddenMetrics(context, [...metrics]);
  const visible = new Set<string>();
  if (exceptions.some((item) => item.dataset !== undefined)) {
    const allowed = await context.access.describableDatasets(context.principal);
    const datasets = await context.db
      .select({ id: powerbiDataset.id, name: powerbiDataset.name })
      .from(powerbiDataset)
      .where(and(allowed, isNull(powerbiDataset.removed_at)));
    const ids = datasets.map((row) => row.id);
    const names = new Map(datasets.map((row) => [row.id, row.name]));
    const see = (
      datasetId: string,
      target: { table?: string; column?: string },
    ) => {
      for (const dataset of [datasetId, names.get(datasetId)])
        visible.add(exceptionKey({ dataset, ...target }));
    };
    for (const id of ids) see(id, {});
    if (ids.length > 0) {
      const tables = await context.db
        .select({
          id: powerbiTable.id,
          name: powerbiTable.name,
          dataset_id: powerbiTable.dataset_id,
        })
        .from(powerbiTable)
        .where(
          and(
            inArray(powerbiTable.dataset_id, ids),
            isNull(powerbiTable.removed_at),
          ),
        );
      for (const row of tables) see(row.dataset_id, { table: row.name });
      const hides = !(await readsPii(context));
      const columns = await context.db
        .select({
          name: powerbiColumn.name,
          table: powerbiTable.name,
          dataset_id: powerbiColumn.dataset_id,
        })
        .from(powerbiColumn)
        .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiColumn.table_id))
        .where(
          and(
            inArray(powerbiColumn.dataset_id, ids),
            isNull(powerbiColumn.removed_at),
            isNull(powerbiTable.removed_at),
            hides ? not(piiColumn(powerbiColumn, powerbiTable)) : undefined,
          ),
        );
      for (const row of columns)
        see(row.dataset_id, { column: columnTarget(row.table, row.name) });
    }
  }
  return exceptions.filter(({ metric, term, dataset, table, column }) =>
    metric !== undefined
      ? !hidden.has(metric)
      : term !== undefined ||
        visible.has(exceptionKey({ dataset, table, column })),
  );
}

/**
 * Anyone signed in may read them: an agent reads them before it names,
 * describes or groups anything. The exceptions come as a count per rule, never
 * the list: a baseline over a large book holds thousands, and an element's own
 * checks show its exception and reason.
 */
export async function getConventionsForAgents(context: ServiceContext) {
  const { guide, exceptions, ...rules } = await currentConventions(context.db);
  const counts: Record<string, number> = {};
  for (const { rule } of exceptions) counts[rule] = (counts[rule] ?? 0) + 1;
  return {
    preset: rules.preset,
    guide,
    summary: summariseRules({ ...rules, exceptions }),
    rules,
    exceptions: counts,
  };
}

/**
 * Every rule with its value in force, and `company` as its source when the
 * company's part holds its key or anything under it. Anyone signed in may read
 * them, as they may the conventions. A rule is off when `off` names it or the
 * check that applies it.
 */
export async function listRules(context: Pick<ServiceContext, "db">) {
  const { conventions, company } = await conventionsInForce(context.db);
  const off = new Set(
    RULES.filter((rule) => isRuleOff(rule, conventions)).map(({ id }) => id),
  );
  return {
    rules: RULES.map(({ id, check, target, path, allowed }) => ({
      id,
      check,
      target,
      value: path === null ? null : valueAt(conventions, path),
      source:
        path !== null && valueAt(company, path) !== undefined
          ? ("company" as const)
          : ("preset" as const),
      allowed: allowed === null ? null : [...allowed],
      off: off.has(id),
      exceptions: conventions.exceptions.filter((item) => item.rule === id)
        .length,
    })),
    fixed: [...FIXED_RULES],
  };
}

/** How many rules are off and how many exceptions the conventions in force make; a check in `off` counts each of its rules. */
export async function weakenedBy(context: Pick<ServiceContext, "db">) {
  const conventions = await currentConventions(context.db);
  return {
    rules_off: RULES.filter((rule) => isRuleOff(rule, conventions)).length,
    exceptions: conventions.exceptions.length,
  };
}

/** The company's part of the version in force, as stored, for whoever may edit the conventions. */
export async function getCompanyPartAsAdmin(context: ServiceContext) {
  await context.access.require(context.principal, BOOK, "edit_conventions");
  return (await conventionsInForce(context.db)).company;
}

/** Validates, versions and announces; see setConventions. */
export async function setConventionsAsAdmin(
  context: ServiceContext,
  document: unknown,
) {
  await context.access.require(context.principal, BOOK, "edit_conventions");
  return setConventions(context, context.principal, document);
}

/** Applies a company part, or only says what it would change; see applyConventions. */
export async function applyAsAdmin(context: ServiceContext, input: ApplyInput) {
  await context.access.require(context.principal, BOOK, "edit_conventions");
  return applyConventions(context, input);
}

/**
 * The exceptions nothing needs any more, as GET /metrics/:name/checks is
 * answered: to a curator, for one metric they may see, or for the whole book
 * among the exceptions whose element they may see.
 */
export async function unusedExceptionsAsCurator(
  context: ServiceContext,
  reference?: string,
) {
  await requireCurator(context);
  const conventions = await currentConventions(context.db);
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  if (reference !== undefined) {
    const found = await resolveMetric(context.db, allowed, hides, reference);
    return unusedExceptions(context, conventions, { metric: found.name });
  }
  const exceptions = await visibleExceptions(context, conventions.exceptions);
  const visible = { ...conventions, exceptions };
  // Checked on the model the curator is shown, so whether an exception is used never tells of a hidden PII column.
  const elements = await checkedElements(
    context,
    { conventions: visible, exceptions: exceptionIndex(visible) },
    allowed,
    hides,
  );
  return unusedExceptions(context, visible, undefined, elements);
}

/** Every saved version, newest first, for whoever may edit the conventions. */
export async function listVersionsAsAdmin(context: ServiceContext) {
  await context.access.require(context.principal, BOOK, "edit_conventions");
  return listVersions(context.db);
}

/** What a document would change against the conventions in force, saving nothing. */
export async function diffAsAdmin(context: ServiceContext, document: unknown) {
  await context.access.require(context.principal, BOOK, "edit_conventions");
  return diffConventions(
    await currentConventions(context.db),
    resolve(document),
  );
}
