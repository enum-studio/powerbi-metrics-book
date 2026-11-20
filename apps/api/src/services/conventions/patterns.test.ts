import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  companyPartSchema,
  conventionsSchema,
  PRESET_NAMES,
} from "./schema.js";
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

  it("walks every schema property and preset key for pattern or regex inputs", () => {
    const walk = (value: unknown, schema = false): void => {
      if (typeof value !== "object" || value === null) return;
      const entries: [string, unknown][] = Object.entries(value);
      for (const [key, child] of entries) {
        if (!schema) expect(key).not.toMatch(/pattern|regex/i);
        // pbmb check runs the shipped schema through Python's re, which backtracks.
        if (schema) expect(key).not.toBe("pattern");
        if (
          schema &&
          key === "properties" &&
          typeof child === "object" &&
          child !== null
        )
          for (const name of Object.keys(child))
            expect(name).not.toMatch(/pattern|regex/i);
        walk(child, schema);
      }
    };
    walk(z.toJSONSchema(conventionsSchema), true);
    walk(z.toJSONSchema(companyPartSchema), true);
    for (const preset of PRESET_NAMES) walk(resolve({ preset }));
  });

  it("refuses a 1 MiB column target built to make a pattern backtrack, within 100 ms", () => {
    const hostile = `'${"'[".repeat(512 * 1024)}`;
    const started = performance.now();
    const problems = validateConventions({
      format: 1,
      exceptions: [
        {
          rule: "column_fields.definition",
          dataset: "Sales",
          column: hostile,
          reason: "Kept.",
        },
      ],
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(problems.map(({ path }) => path)).toContain("exceptions.0.column");
  });

  it("holds every target and name to 500 characters, and reads a column as '<table>'[<column>]", () => {
    const long = "a".repeat(501);
    const exception = (target: object) =>
      validateConventions({
        exceptions: [{ rule: "naming.kinds", reason: "Kept.", ...target }],
      });
    expect(exception({ metric: long }).length).toBeGreaterThan(0);
    expect(
      validateConventions({ naming: { forbidden_words: [long] } }),
    ).toEqual([expect.objectContaining({ path: "naming.forbidden_words.0" })]);
    expect(
      validateConventions({
        drafting: { skip: { name_prefixes: [long] } },
      }),
    ).toEqual([
      expect.objectContaining({ path: "drafting.skip.name_prefixes.0" }),
    ]);
    const column = (target: string) =>
      validateConventions({
        exceptions: [
          {
            rule: "column_fields.definition",
            dataset: "Sales",
            column: target,
            reason: "Kept.",
          },
        ],
      });
    for (const valid of ["'Sales'[Channel]", "'a'['b'[c]", "'It''s'[x]"])
      expect(column(valid)).toEqual([]);
    for (const invalid of [
      "Sales[Channel]",
      "'Sales'Channel]",
      "''[Channel]",
      "'Sales'[]",
      "'Sales'[Channel",
      "'Sales'[Chan\nnel]",
      `'Sales'[${long}]`,
    ])
      expect(column(invalid).length).toBeGreaterThan(0);
    expect(
      validateConventions({ naming: { qualifiers: { Per: ["per"] } } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateConventions({
        variants: { axes: { currency: { values: ["eur"] } } },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("allows dynamic regular expressions only in the three reviewed modules", () => {
    const source = new URL("../../", import.meta.url);
    const allowed = [
      "http/docs.ts",
      "http/public-paths.ts",
      "services/mirror/read.ts",
    ];
    const unexpected = readdirSync(source, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => file.endsWith(".ts"))
      .filter(
        (file) =>
          !file.endsWith(".test.ts") && !file.endsWith("_security_test.ts"),
      )
      .filter((file) => !allowed.includes(file))
      .filter((file) =>
        readFileSync(new URL(file, source), "utf8").includes("new RegExp"),
      );
    expect(unexpected).toEqual([]);
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

  it.each([null, 7, { prefix: "_" }])(
    "leaves non-string skip and dismiss patterns for validation: %o",
    (pattern) => {
      const document = {
        drafting: {
          skip: { name_patterns: [pattern] },
          dismiss: [{ name_pattern: pattern, reason: "Internal." }],
        },
      };
      const upgraded = upgrade(document);
      expect(upgraded).toEqual(document);
      expect(validateConventions(upgraded).map(({ path }) => path)).toEqual(
        expect.arrayContaining([
          "drafting.skip.name_patterns",
          "drafting.dismiss.0",
        ]),
      );
    },
  );

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
