import { describe, expect, it } from "vitest";
import { FIXED_RULES, RULES, ruleById, rulesOfCheck } from "./rules.js";
import { CHECK_NAMES, PRESET_NAMES } from "./schema.js";
import { resolve, validateConventions, valueAt } from "./store.js";

/** A document setting one path, the rest left to the preset. */
const setting = (path: readonly string[], value: unknown): unknown =>
  path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);

describe("the rule registry", () => {
  it("gives every check at least one rule, and each rule an id of its own", () => {
    for (const check of CHECK_NAMES)
      expect(rulesOfCheck(check).length, check).toBeGreaterThan(0);
    const ids = [...RULES, ...FIXED_RULES].map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names each rule by the path it reads, or by its check when it reads none", () => {
    for (const rule of RULES)
      expect(rule.id).toBe(
        rule.path === null ? rule.check : rule.path.join("."),
      );
    expect(ruleById("naming.kinds")).toMatchObject({
      check: "metric_name_form",
      target: "metric",
    });
    expect(ruleById("metric_base_variant")).toMatchObject({ path: null });
    expect(ruleById("term_fields.values")?.target).toBe("term");
    expect(ruleById("no.such_rule")).toBeUndefined();
  });

  it.each(PRESET_NAMES)("finds every rule's key in the %s preset", (preset) => {
    const document = resolve({ preset });
    for (const rule of RULES)
      if (rule.path !== null)
        expect(valueAt(document, rule.path), rule.id).toBeDefined();
  });

  it("lists, for a rule that takes one of a few values, values the conventions accept and only those", () => {
    const document = resolve({});
    for (const rule of RULES) {
      if (rule.allowed === null || rule.path === null) continue;
      // A field's rule is set by its required; another by its own value.
      const field = typeof valueAt(document, rule.path) === "object";
      const path = field ? [...rule.path, "required"] : rule.path;
      for (const value of rule.allowed)
        expect(validateConventions(setting(path, value)), rule.id).toEqual([]);
      expect(
        validateConventions(setting(path, "no_such_value")),
        rule.id,
      ).not.toEqual([]);
    }
  });

  it("lists the rules that stay fixed, each with its reason", () => {
    expect(FIXED_RULES.map((rule) => rule.id)).toEqual([
      "trust.states",
      "variants.base",
      "keys.unique",
      "pii",
      "format",
    ]);
    for (const rule of FIXED_RULES) expect(rule.reason).not.toBe("");
  });
});
