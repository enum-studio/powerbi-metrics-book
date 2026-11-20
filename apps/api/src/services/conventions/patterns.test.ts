import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conventionsSchema, PRESET_NAMES } from "./schema.js";
import { resolve, validateConventions } from "./store.js";
import { summariseRules } from "./service.js";
import { LEGACY_TRANSFORMS } from "./upgrade.js";

const upgrade = (document: Record<string, unknown>, version = 7) =>
  LEGACY_TRANSFORMS.reduce(
    (each, transform) => transform(each, version),
    document,
  );

describe("text drafting rules", () => {
  it("accepts prefixes and names, including literal metacharacters", () => {
    expect(
      validateConventions({
        drafting: {
          skip: { name_prefixes: ["a.b"], names: ["(a|b)"] },
          dismiss: [
            { prefix: "_", reason: "Internal." },
            { name: "Test", reason: "Test." },
          ],
        },
      }),
    ).toEqual([]);
  });

  it.each([
    { skip: { name_patterns: ["^_"] } },
    { dismiss: [{ name_pattern: "^_", reason: "Internal." }] },
    { dismiss: [{ prefix: "_", name: "Test", reason: "Both." }] },
    { dismiss: [{ reason: "Neither." }] },
  ])("refuses obsolete or ambiguous selectors: %o", (drafting) => {
    expect(validateConventions({ drafting }).length).toBeGreaterThan(0);
  });

  it("describes prefixes and names as case-insensitive text", () => {
    const summary = summariseRules(
      resolve({
        drafting: {
          skip: { name_prefixes: ["_"], names: ["Test"] },
          dismiss: [
            { prefix: "Internal", reason: "Internal." },
            { name: "Helper", reason: "Helper." },
          ],
        },
      }),
    ).join("\n");
    expect(summary).toContain("name starts with _ (case-insensitive)");
    expect(summary).toContain("measures named Test (case-insensitive)");
    expect(summary).toContain("name starts with Internal (case-insensitive)");
    expect(summary).toContain("name equals Helper (case-insensitive)");
  });

  it("walks the schema and every preset without a regular expression input", () => {
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        expect(["name_pattern", "name_patterns"]).not.toContain(key);
        walk(child);
      }
    };
    walk(z.toJSONSchema(conventionsSchema));
    for (const preset of PRESET_NAMES) walk(resolve({ preset }));
    for (const file of ["schema.ts", "../book/drafter.ts"]) {
      expect(
        readFileSync(new URL(file, import.meta.url), "utf8"),
      ).not.toContain("new RegExp");
    }
  });
});

describe("legacy drafting patterns", () => {
  it.each([
    ["^_", { prefix: "_" }],
    ["^Test$", { name: "Test" }],
    [String.raw`^a\.b`, { prefix: "a.b" }],
  ])("turns %s into text in skip and dismiss", (pattern, selector) => {
    expect(
      upgrade({
        drafting: {
          skip: { name_patterns: [pattern] },
          dismiss: [{ name_pattern: pattern, reason: "Internal." }],
        },
      }),
    ).toEqual({
      drafting: {
        skip: {
          name_prefixes: "prefix" in selector ? [selector.prefix] : [],
          names: "name" in selector ? [selector.name] : [],
        },
        dismiss: [{ ...selector, reason: "Internal." }],
      },
    });
  });

  it.each(["^a.b", "foo", "(a|b)"])(
    "refuses %s with recovery instructions",
    (pattern) => {
      expect(() =>
        upgrade({ drafting: { skip: { name_patterns: [pattern] } } }),
      ).toThrow(
        `Conventions version 7 has the drafting pattern ${pattern}, which this release cannot turn into a prefix or a name. Rewrite it as a prefix or a name with \`pbmb conventions edit\` on the release before this one, then deploy again. Nothing was applied.`,
      );
    },
  );
});
