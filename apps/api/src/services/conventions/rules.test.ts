import { describe, expect, it } from "vitest";
import {
  checkApplying,
  FIXED_RULES,
  isRuleOff,
  OFF_NAMES,
  RULES,
  ruleById,
  rulesOfCheck,
  valueAt,
} from "./rules.js";
import { CHECK_NAMES, PRESET_NAMES } from "./schema.js";
import { resolve, validateConventions } from "./store.js";

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

  it("finds every key a rule reads in the presets", () => {
    const document = resolve({});
    for (const rule of RULES)
      for (const id of rule.reads)
        expect(valueAt(document, id.split(".")), rule.id).toBeDefined();
  });

  it("takes in off every rule id and every check name, and nothing else", () => {
    for (const name of [...RULES.map((rule) => rule.id), ...CHECK_NAMES])
      expect(OFF_NAMES).toContain(name);
    expect(OFF_NAMES).toHaveLength(new Set(OFF_NAMES).size);
  });

  it("says which check applies not_the_same_as under its required, and what turns it off", () => {
    const rule = ruleById("metric_fields.not_the_same_as");
    if (rule === undefined) throw new Error("No not_the_same_as rule.");
    const always = { metric_fields: { not_the_same_as: { required: true } } };
    expect(checkApplying(rule, resolve({}))).toBe("metric_not_the_same_as");
    expect(checkApplying(rule, resolve(always))).toBe("metric_fields");
    expect(checkApplying(rule, resolve({ preset: "minimal" }))).toBe(
      "metric_fields",
    );
    expect(isRuleOff(rule, resolve({ off: ["metric_fields"] }))).toBe(false);
    expect(
      isRuleOff(rule, resolve({ ...always, off: ["metric_fields"] })),
    ).toBe(true);
    expect(
      isRuleOff(
        rule,
        resolve({ ...always, off: ["metric_fields.not_the_same_as"] }),
      ),
    ).toBe(true);
    expect(isRuleOff(rule, resolve({ off: ["metric_not_the_same_as"] }))).toBe(
      true,
    );
    const minimal = (off: string[]) => resolve({ preset: "minimal", off });
    expect(isRuleOff(rule, minimal(["metric_fields"]))).toBe(true);
    expect(isRuleOff(rule, minimal(["metric_not_the_same_as"]))).toBe(false);
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
