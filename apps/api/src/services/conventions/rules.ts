import type { CheckName, Conventions } from "./schema.js";

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
  /** The ids of other keys the rule reads, so a company that sets one of them sets this rule too. */
  readonly reads: readonly string[];
  /**
   * Another check that applies the rule, while the key's `required` is one of
   * `when`; under any other value the rule's own check applies it.
   */
  readonly shared: {
    readonly check: CheckName;
    readonly when: readonly (string | boolean)[];
  } | null;
}

const REQUIRED = [true, false] as const;

const keyed = (
  check: CheckName,
  target: RuleTarget,
  id: string,
  allowed: readonly (string | boolean)[] | null = null,
  more: Partial<Pick<Rule, "reads" | "shared">> = {},
): Rule => ({
  id,
  check,
  target,
  path: id.split("."),
  allowed,
  reads: [],
  shared: null,
  ...more,
});

const keyless = (check: CheckName, target: RuleTarget): Rule => ({
  id: check,
  check,
  target,
  path: null,
  allowed: null,
  reads: [],
  shared: null,
});

export const RULES: readonly Rule[] = [
  keyed("metric_name_form", "metric", "naming.case", ["snake_case", "none"]),
  keyed("metric_name_form", "metric", "naming.kinds"),
  keyless("metric_name_generated", "metric"),
  keyed("metric_name_comparison", "metric", "naming.forbidden_words"),
  keyed("metric_money_qualifier", "metric", "naming.money_qualifier", REQUIRED),
  keyed("metric_qualifier_order", "metric", "naming.qualifier_order", null, {
    reads: ["naming.qualifiers"],
  }),
  keyed("metric_fields", "metric", "metric_fields.definition", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.aliases", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.when_to_use", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.grain_and_filters", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.unit", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.category", REQUIRED),
  keyed("metric_fields", "metric", "metric_fields.custom"),
  // A content word is any but those of the kinds, the placed qualifiers, the
  // money qualifiers and ignore_words.
  keyed(
    "metric_not_the_same_as",
    "metric",
    "metric_fields.not_the_same_as",
    [...REQUIRED, "when_label_shares_a_word"],
    {
      reads: [
        "naming.kinds",
        "naming.qualifier_order",
        "naming.qualifiers",
        "naming.money_qualifier",
      ],
      shared: { check: "metric_fields", when: [true] },
    },
  ),
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

/** What `off` and an exception's `rule` take: a rule id, or a check name for every rule of the check. */
export const OFF_NAMES = [
  ...new Set(RULES.flatMap((rule) => [rule.id, rule.check])),
];

const isDocument = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a key's path; undefined where the document does not hold it. */
export const valueAt = (document: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      isDocument(value) && Object.hasOwn(value, key) ? value[key] : undefined,
    document,
  );

/** The check that applies the rule under these conventions; see Rule.shared. */
export function checkApplying(rule: Rule, conventions: Conventions): CheckName {
  const { shared, path } = rule;
  if (shared === null || path === null) return rule.check;
  const required = valueAt(conventions, [...path, "required"]);
  return shared.when.some((value) => value === required)
    ? shared.check
    : rule.check;
}

/**
 * Off when `off` names the rule, or the check that applies it under these
 * conventions; checkMetric and checkTerm skip a result on the same terms.
 */
export function isRuleOff(rule: Rule, conventions: Conventions): boolean {
  const off: readonly string[] = conventions.off;
  return (
    off.includes(rule.id) || off.includes(checkApplying(rule, conventions))
  );
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
