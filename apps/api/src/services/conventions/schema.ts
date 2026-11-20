import { z } from "zod";
import { COMPARISONS } from "../../db/schema/book.js";
import { OFF_NAMES, RULE_TARGETS, RULES, ruleById } from "./rules.js";

/*
 * The conventions: every rule a check or the drafter applies is a key here,
 * never a line of code. Beside the spec's keys, five hold rules the spec
 * states only in words: naming.qualifiers, naming.money_qualifier.units,
 * metric_fields.not_the_same_as.ignore_words, term_fields.definition and
 * term_fields.values.
 */

export const PRESET_NAMES = ["metrics_book", "minimal"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const METRIC_CHECK_NAMES = [
  "metric_name_form",
  "metric_name_generated",
  "metric_name_comparison",
  "metric_money_qualifier",
  "metric_qualifier_order",
  "metric_fields",
  "metric_not_the_same_as",
  "metric_base_variant",
] as const;
export const TERM_CHECK_NAMES = ["term_fields"] as const;
export const ELEMENT_CHECK_NAMES = [
  "dataset_fields",
  "table_fields",
  "column_fields",
] as const;
export const CHECK_NAMES = [
  ...METRIC_CHECK_NAMES,
  ...TERM_CHECK_NAMES,
  ...ELEMENT_CHECK_NAMES,
] as const;
export type MetricCheckName = (typeof METRIC_CHECK_NAMES)[number];
export type TermCheckName = (typeof TERM_CHECK_NAMES)[number];
export type CheckName = (typeof CHECK_NAMES)[number];

/*
 * Every name, word and exception target is held to 500 characters, and none
 * is read with a pattern in conventions.schema.json: a refinement checks it
 * here, so Python's re, which backtracks, never reads one offline.
 */
const short = z.string().max(500);
const key = short.refine(
  (text) => /^[a-z][a-z0-9_]*$/.test(text),
  "Use lowercase letters, digits and underscores, starting with a letter.",
);
const words = z.array(short.min(1));
const required = z.strictObject({ required: z.boolean() });

const hasUniqueKeys = (items: { key: string }[]): boolean =>
  new Set(items.map((item) => item.key)).size === items.length;
const UNIQUE = "Each key is used once.";

const customFieldPartSchema = z
  .strictObject({
    key,
    label: short.min(1),
    type: z.enum(["text", "number", "boolean", "date", "choice"]),
    values: words.min(1).optional(),
    required: z.boolean().optional(),
  })
  .refine(
    (field) => (field.type === "choice") === (field.values !== undefined),
    {
      message:
        "A choice field lists its values, and only a choice field has values.",
      path: ["values"],
    },
  );
export const customFieldSchema = customFieldPartSchema.safeExtend({
  required: z.boolean().default(false),
});
export type CustomFieldSpec = z.infer<typeof customFieldSchema>;

const customFields = z.array(customFieldSchema).refine(hasUniqueKeys, UNIQUE);
const customFieldsPart = z
  .array(customFieldPartSchema)
  .refine(hasUniqueKeys, UNIQUE);

const kind = short.refine(
  (text) => text.length > 1 && text.startsWith("_") !== text.endsWith("_"),
  "A kind ends with an underscore when it opens the key (total_) or starts with one when it follows what it counts (_rate).",
);

const naming = z
  .strictObject({
    case: z.enum(["snake_case", "none"]),
    kinds: z.array(kind),
    forbidden_words: words,
    money_qualifier: z.strictObject({
      required: z.boolean(),
      values: words,
      units: words,
    }),
    qualifier_order: z.array(key),
    qualifiers: z.record(key, words),
    label: z.enum(["sentence_case", "none"]),
  })
  // A group qualifier_order does not place may stay, as a preset's does
  // under a company's shorter order: the checks read only the placed ones.
  .refine(
    (rules) =>
      rules.qualifier_order.every((name) =>
        Object.hasOwn(rules.qualifiers, name),
      ),
    {
      message: "Give qualifiers the words of each one qualifier_order places.",
      path: ["qualifiers"],
    },
  );

const BUILT_IN_AXES = ["period", "comparison", "currency"];

export const currencyCode = z
  .string()
  .refine(
    (code) => code === "local" || /^[A-Z]{3}$/.test(code),
    "Use an ISO 4217 code (EUR) or local.",
  );

const variants = z.strictObject({
  axes: z
    .strictObject({
      period: z.strictObject({ values: words }),
      comparison: z.strictObject({ values: z.array(z.enum(COMPARISONS)) }),
      currency: z.strictObject({
        values: z.union([
          z.literal("iso_4217_or_local"),
          z.array(currencyCode),
        ]),
      }),
      custom: z
        .array(z.strictObject({ key, values: z.array(key).min(1) }))
        .refine(hasUniqueKeys, UNIQUE)
        .refine(
          (axes) => axes.every((axis) => !BUILT_IN_AXES.includes(axis.key)),
          "A custom axis takes a key other than period, comparison and currency.",
        ),
    })
    .refine(
      (axes) =>
        axes.period.values.includes("current") &&
        axes.comparison.values.includes("none"),
      "A base variant's values stay: current among the periods, none among the comparisons.",
    ),
});

const off = z.array(
  z.enum(OFF_NAMES as [string, ...string[]], {
    error: (issue) =>
      `${String(issue.input)} is neither a rule id nor a check name.`,
  }),
);

/**
 * One line of visible text, so a reason reads as text where it is shown and
 * cannot pass for an instruction of its own: no control or format character
 * (\p{Cf}, such as a right-to-left override), which could hide what it says.
 * A refinement, not a pattern: Python's re, which reads
 * conventions.schema.json offline, has no \p{Cc}.
 */
export const exceptionReason = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (reason) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(reason),
    "A reason is one line of visible text.",
  );

const LINE_BREAKS = ["\n", "\r", "\u2028", "\u2029"];

/** '<table>'[<column>], as columnTarget writes it: neither part empty, and one line. */
function isColumnTarget(text: string): boolean {
  const at = text.lastIndexOf("'[");
  return (
    text.startsWith("'") &&
    text.endsWith("]") &&
    at > 1 &&
    at + 2 < text.length - 1 &&
    !LINE_BREAKS.some((line) => text.includes(line))
  );
}

const exception = z
  .strictObject({
    rule: z.enum(RULES.map((rule) => rule.id) as [string, ...string[]], {
      error: (issue) =>
        `${String(issue.input)} is not a rule id. An exception names one rule, never a check.`,
    }),
    reason: exceptionReason,
    metric: short.min(1).optional(),
    term: short.min(1).optional(),
    dataset: short.min(1).optional(),
    table: short.min(1).optional(),
    column: short
      .refine(isColumnTarget, "Write a column as '<table>'[<column>].")
      .optional(),
  })
  .superRefine((item, context) => {
    const target = ruleById(item.rule)?.target;
    if (target === undefined) return;
    // A table or a column is named within its dataset.
    const wanted =
      target === "table" || target === "column"
        ? ["dataset", target]
        : [target];
    const given = RULE_TARGETS.filter((key) => item[key] !== undefined);
    if (given.join() !== wanted.join())
      context.addIssue({
        code: "custom",
        message: `An exception to ${item.rule} names exactly one ${target}: ${wanted.join(" and ")}.`,
      });
  });
export type ConventionsException = z.infer<typeof exception>;

const KEYED_BY = ["rule", ...RULE_TARGETS] as const;
/** The rule and the element an exception is for, so the same one twice is found; without a rule, the element alone. */
export const exceptionKey = (
  item: Partial<Pick<ConventionsException, (typeof KEYED_BY)[number]>>,
): string => JSON.stringify(KEYED_BY.map((key) => item[key] ?? null));

export const columnTarget = (table: string, column: string) =>
  `'${table}'[${column}]`;

const exceptions = z
  .array(exception)
  .refine(
    (items) => new Set(items.map(exceptionKey)).size === items.length,
    "Each rule and element has one exception at most.",
  );

export const conventionsSchema = z.strictObject({
  preset: z.enum(PRESET_NAMES),
  // 256 KiB, the most the CLI reads from a guide file.
  guide: z.string().max(262_144),
  naming,
  metric_fields: z.strictObject({
    definition: required,
    aliases: required,
    when_to_use: required,
    not_the_same_as: z.strictObject({
      required: z.union([z.boolean(), z.literal("when_label_shares_a_word")]),
      ignore_words: words,
    }),
    grain_and_filters: required,
    unit: z.strictObject({ required: z.boolean(), values: words }),
    category: required,
    custom: customFields,
  }),
  term_fields: z.strictObject({
    definition: required,
    values: z.strictObject({
      required: z.union([z.boolean(), z.literal("when_categorical")]),
    }),
    custom: customFields,
  }),
  dataset_fields: z.strictObject({
    definition: required,
    when_to_use: required,
    owner: required,
    freshness: required,
    caveats: required,
    custom: customFields,
  }),
  table_fields: z.strictObject({
    definition: required,
    grain_and_filters: z.strictObject({
      required: z.union([z.boolean(), z.literal("when_fact")]),
    }),
    caveats: required,
    custom: customFields,
  }),
  column_fields: z.strictObject({
    definition: z.strictObject({
      required: z.union([z.boolean(), z.literal("when_visible_and_no_term")]),
    }),
    unit: z.strictObject({
      required: z.union([z.boolean(), z.literal("when_numeric")]),
      values: words,
    }),
    blank_means: required,
    custom: customFields,
  }),
  variants,
  drafting: z.strictObject({
    group_by_fingerprint: z.boolean(),
    recognise_time_intelligence: z.boolean(),
    recognise_blank_as_zero: z.boolean(),
    period_words: z.strictObject({
      previous_year: words,
      previous_quarter: words,
      previous_month: words,
      previous_week: words,
      previous_day: words,
    }),
    name_hints: z.strictObject({ period: words, currency: words }),
    skip: z.strictObject({
      hidden_measures: z.boolean(),
      display_folders: z.array(short),
      tables: z.array(short),
      name_prefixes: z.array(short),
      names: z.array(short),
    }),
    dismiss: z.array(
      z.union(
        [
          z.strictObject({ prefix: short, reason: z.string().min(1) }),
          z.strictObject({ name: short, reason: z.string().min(1) }),
        ],
        {
          error:
            'A dismiss rule gives a prefix or a name, not both, and a reason. `name_pattern` is gone: write `^_` as `prefix: "_"`.',
        },
      ),
    ),
  }),
  trust: z.strictObject({
    agent_verify_requires: z.union([
      z.literal("all_checks"),
      z.array(z.enum(CHECK_NAMES)),
    ]),
    human_verify_from: z.enum(["browser", "any"]),
  }),
  off,
  exceptions,
});

export type Conventions = z.infer<typeof conventionsSchema>;

/** Every key optional at every depth, as resolve merges a part over its preset; an array stays whole. */
const optionalShape = (shape: z.core.$ZodShape): z.core.$ZodShape =>
  Object.fromEntries(
    Object.entries(shape).map(([name, value]) => [
      name,
      z.optional(
        value instanceof z.ZodObject
          ? z.strictObject(optionalShape(value.shape))
          : value === customFields
            ? customFieldsPart
            : value,
      ),
    ]),
  );

/**
 * What a company part may hold, for conventions.schema.json and an offline
 * check of conventions.yml. A refinement reads the whole document, so it is
 * left to resolve, which checks the part merged over its preset.
 */
export const companyPartSchema = z.strictObject({
  format: z.literal(1),
  ...optionalShape(conventionsSchema.shape),
});
/** What the drafter reads: how measures are grouped, named, skipped and dismissed. */
export type DraftingRules = Conventions["drafting"];
