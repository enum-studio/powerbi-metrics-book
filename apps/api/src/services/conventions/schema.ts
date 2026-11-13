import { z } from "zod";
import { COMPARISONS } from "../../db/schema/book.js";

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
export const CHECK_NAMES = [
  ...METRIC_CHECK_NAMES,
  ...TERM_CHECK_NAMES,
] as const;
export type MetricCheckName = (typeof METRIC_CHECK_NAMES)[number];
export type TermCheckName = (typeof TERM_CHECK_NAMES)[number];
export type CheckName = (typeof CHECK_NAMES)[number];

const key = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lowercase letters, digits and underscores, starting with a letter.",
  );
const words = z.array(z.string().min(1));
const pattern = z
  .string()
  .refine(isRegExp, "This is not a valid regular expression.");
const required = z.strictObject({ required: z.boolean() });

function isRegExp(source: string): boolean {
  try {
    new RegExp(source, "u");
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

const hasUniqueKeys = (items: { key: string }[]): boolean =>
  new Set(items.map((item) => item.key)).size === items.length;
const UNIQUE = "Each key is used once.";

export const customFieldSchema = z
  .strictObject({
    key,
    label: z.string().min(1),
    type: z.enum(["text", "number", "boolean", "date", "choice"]),
    values: z.array(z.string().min(1)).min(1).optional(),
    required: z.boolean().default(false),
  })
  .refine(
    (field) => (field.type === "choice") === (field.values !== undefined),
    {
      message:
        "A choice field lists its values, and only a choice field has values.",
      path: ["values"],
    },
  );
export type CustomFieldSpec = z.infer<typeof customFieldSchema>;

const customFields = z.array(customFieldSchema).refine(hasUniqueKeys, UNIQUE);

const kind = z
  .string()
  .refine(
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
  .regex(/^(?:[A-Z]{3}|local)$/, "Use an ISO 4217 code (EUR) or local.");

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

export const conventionsSchema = z.strictObject({
  preset: z.enum(PRESET_NAMES),
  guide: z.string(),
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
  element_fields: z.strictObject({ custom: customFields }),
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
      display_folders: z.array(z.string()),
      tables: z.array(z.string()),
      name_patterns: z.array(pattern),
    }),
    dismiss: z.array(
      z.strictObject({ name_pattern: pattern, reason: z.string().min(1) }),
    ),
  }),
  trust: z.strictObject({
    agent_verify_requires: z.union([
      z.literal("all_checks"),
      z.array(z.enum(CHECK_NAMES)),
    ]),
    human_verify_from: z.enum(["browser", "any"]),
  }),
  checks: z.strictObject({ off: z.array(z.enum(CHECK_NAMES)) }),
});

export type Conventions = z.infer<typeof conventionsSchema>;
/** What the drafter reads: how measures are grouped, named, skipped and dismissed. */
export type DraftingRules = Conventions["drafting"];
