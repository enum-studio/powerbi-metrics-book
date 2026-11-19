import type { CheckName } from "./schema.js";

/*
 * Every rule a check applies, by the id `off`, exceptions and findings name
 * it by: the dotted path of the key it reads, or the check's own name for a
 * check that reads none. One rule for each key a check in book/checks.ts
 * reads, under the check that reads it.
 */

export const RULE_TARGETS = [
  "metric",
  "term",
  "dataset",
  "table",
  "column",
] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];

export interface Rule {
  /** The dotted path of the key the rule reads, or the check's name for a check that reads no key. */
  readonly id: string;
  readonly check: CheckName;
  readonly target: RuleTarget;
  /** The key's path in Conventions; null for a check that reads no key. */
  readonly path: readonly string[] | null;
  /**
   * The values the key accepts when it is an enum or literal union; null for
   * free text and lists. A field's key holds its settings, and this lists what
   * its `required` accepts.
   */
  readonly allowed: readonly (string | boolean)[] | null;
}

const REQUIRED = [true, false] as const;

const keyed = (
  check: CheckName,
  target: RuleTarget,
  id: string,
  allowed: readonly (string | boolean)[] | null = null,
): Rule => ({ id, check, target, path: id.split("."), allowed });

const keyless = (check: CheckName, target: RuleTarget): Rule => ({
  id: check,
  check,
  target,
  path: null,
  allowed: null,
});

export const RULES: readonly Rule[] = [
  keyed("metric_name_form", "metric", "naming.case", ["snake_case", "none"]),
  keyed("metric_name_form", "metric", "naming.kinds"),
  keyless("metric_name_generated", "metric"),
  keyed("metric_name_comparison", "metric", "naming.forbidden_words"),
  keyed("metric_money_qualifier", "metric", "naming.money_qualifier"),
  // Its words come from naming.qualifiers, for the groups it places.
  keyed("metric_qualifier_order", "metric", "naming.qualifier_order"),
  keyed("metric_fields", "metric", "metric_fields.definition", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.aliases", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.when_to_use", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.grain_and_filters", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.unit", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.category", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.custom"),
  // metric_fields asks for it when required is true; this check, when another
  // label shares a word, reading ignore_words too.
  keyed("metric_not_the_same_as", "metric", "metric_fields.not_the_same_as", [
    ...REQUIRED,
    "when_label_shares_a_word",
  ]),
  keyless("metric_base_variant", "metric"),
  keyed("term_fields", "term", "term_fields.definition", REQUIRED),
  keyed("term_fields", "term", "term_fields.values", [
    ...REQUIRED,
    "when_categorical",
  ]),
  keyed("term_fields", "term", "term_fields.custom"),
];

const byId = new Map(RULES.map((rule) => [rule.id, rule]));

export function ruleById(id: string): Rule | undefined {
  return byId.get(id);
}

export function rulesOfCheck(check: CheckName): readonly Rule[] {
  return RULES.filter((rule) => rule.check === check);
}

/** What no company changes, with why; the spec's "What stays fixed". */
export interface FixedRule {
  readonly id: string;
  readonly reason: string;
}

export const FIXED_RULES: readonly FixedRule[] = [
  {
    id: "trust.states",
    reason:
      "The three trust states and what each means: approval, the checks and every reader of the book depend on them. trust.human_verify_from stays a setting.",
  },
  {
    id: "variants.base",
    reason:
      "A variant's base values, current and none: a variant is the same calculation shifted, and the base is where the shift starts.",
  },
  {
    id: "keys.unique",
    reason:
      "Unique metric keys and term names: agents, links and the CLI address them by these.",
  },
  {
    id: "pii",
    reason:
      "PII rules are set on the admin PII page, never in the conventions.",
  },
  { id: "format", reason: "It says how to read the rest." },
];
