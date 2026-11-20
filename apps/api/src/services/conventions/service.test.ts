import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import { asPerson, rolledBack } from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { event } from "../../db/schema/events.js";
import { FIXED_RULES, RULES } from "./rules.js";
import {
  getCompanyPartAsAdmin,
  getConventionsForAgents,
  listRules,
  setConventionsAsAdmin,
  summariseRules,
  weakenedBy,
} from "./service.js";
import { listVersions, resolve } from "./store.js";

afterAll(closeTestPools);

describe("getConventionsForAgents", () => {
  it("gives the guide apart from the rules, and a summary in plain words", async () => {
    const answer = await getConventionsForAgents(asPerson(principals.viewer));
    const stored = resolve({ preset: "metrics_book" });
    expect(answer.preset).toBe("metrics_book");
    expect(answer.guide).toBe(stored.guide);
    expect(answer.rules).not.toHaveProperty("guide");
    expect(answer.rules.naming).toEqual(stored.naming);
    expect(answer.summary).toContain(
      "A metric key is snake_case: lowercase words joined by underscores.",
    );
    const { qualifier_order, qualifiers, kinds } = stored.naming;
    const placed = qualifier_order
      .map((group) => `${group} (${(qualifiers[group] ?? []).join(", ")})`)
      .join(", ");
    expect(answer.summary).toContain(
      `Qualifiers follow this order: ${placed}.`,
    );
    expect(answer.summary).toContainEqual(
      expect.stringContaining(`a kind: ${kinds.join(", ")}.`),
    );
  });

  it("reads the summary from the rules in force, so a change to a rule changes a sentence", () =>
    rolledBack(async (tx) => {
      const admin = asPerson(principals.admin, { db: tx });
      await setConventionsAsAdmin(admin, {
        preset: "minimal",
        naming: { kinds: ["total_"], forbidden_words: ["ly"] },
        metric_fields: {
          custom: [
            {
              key: "source",
              label: "Source",
              type: "choice",
              values: ["erp", "crm"],
            },
          ],
        },
        term_fields: { values: { required: true } },
        off: ["metric_base_variant"],
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: "Kept." },
        ],
        trust: { human_verify_from: "any" },
        drafting: { skip: { tables: ["Staging"] } },
      });
      const { summary } = await getConventionsForAgents(admin);
      expect(summary).toEqual(
        expect.arrayContaining([
          "A metric key starts or ends with a kind: total_. A kind with a trailing underscore opens the key; one with a leading underscore closes it.",
          "A metric key never holds these words: ly. A shifted measure is a variant of its metric, not a metric.",
          "Metrics have the custom field source (Source), one of the listed values: erp, crm; optional.",
          "A term lists its values, each with what it means.",
          "The sync drafts nothing from: measures in the tables Staging.",
          "A person approves a metric from the browser, the CLI or the API.",
          "These rules and checks are off: metric_base_variant.",
          "1 exception lets an element keep failing a rule; get_conventions lists each with its reason.",
        ]),
      );
      expect(summary.join(" ")).not.toContain("snake_case");
    }));

  it("says nothing of a rule that is off or empty", () => {
    const rules = resolve({ preset: "minimal" });
    const text = summariseRules({
      ...rules,
      naming: { ...rules.naming, kinds: [], forbidden_words: [] },
      metric_fields: { ...rules.metric_fields, custom: [] },
    }).join(" ");
    expect(text).not.toContain("starts or ends with a kind");
    expect(text).not.toContain("never holds these words");
    expect(text).not.toContain("custom field");
  });
});

describe("listRules", () => {
  it("gives each rule its value in force, where it comes from and whether it is off, and the fixed rules", () =>
    rolledBack(async (tx) => {
      const viewer = asPerson(principals.viewer, { db: tx });
      const preset = resolve({});
      const before = await listRules(viewer);
      expect(before.rules.map((rule) => rule.id)).toEqual(
        RULES.map((rule) => rule.id),
      );
      expect(before.rules.every((rule) => rule.source === "preset")).toBe(true);
      expect(before.fixed).toEqual(FIXED_RULES);

      await setConventionsAsAdmin(asPerson(principals.admin, { db: tx }), {
        format: 1,
        naming: { kinds: ["total_"] },
        metric_fields: { not_the_same_as: { ignore_words: ["net"] } },
        off: ["metric_base_variant", "naming.case"],
        exceptions: [
          { rule: "naming.kinds", metric: "orders", reason: "Kept." },
          { rule: "naming.kinds", metric: "sales", reason: "Kept too." },
        ],
      });
      const after = await listRules(viewer);
      const byId = new Map(after.rules.map((rule) => [rule.id, rule]));
      expect(byId.get("naming.kinds")).toEqual({
        id: "naming.kinds",
        check: "metric_name_form",
        target: "metric",
        value: ["total_"],
        source: "company",
        allowed: null,
        off: false,
        exceptions: 2,
      });
      expect(byId.get("metric_fields.not_the_same_as")).toMatchObject({
        source: "company",
        value: {
          ...preset.metric_fields.not_the_same_as,
          ignore_words: ["net"],
        },
        allowed: [true, false, "when_label_shares_a_word"],
      });
      expect(byId.get("naming.case")).toMatchObject({
        value: preset.naming.case,
        source: "preset",
        off: true,
      });
      expect(byId.get("naming.money_qualifier")?.allowed).toEqual([
        true,
        false,
      ]);
      expect(byId.get("metric_base_variant")).toMatchObject({
        value: null,
        source: "preset",
        off: true,
      });
    }));
});

describe("listRules, off and source", () => {
  const rulesUnder = async (tx: Db, part: object) => {
    await setConventionsAsAdmin(asPerson(principals.admin, { db: tx }), {
      format: 1,
      ...part,
    });
    const { rules } = await listRules(asPerson(principals.viewer, { db: tx }));
    return new Map(rules.map((rule) => [rule.id, rule]));
  };

  it("gives a rule the company's source only when the company sets its own key", () =>
    rolledBack(async (tx) => {
      const byId = await rulesUnder(tx, {
        naming: { qualifiers: { per: ["per", "each"] } },
      });
      expect(byId.get("naming.qualifier_order")?.source).toBe("preset");
    }));

  it("turns not_the_same_as off by the check that applies it under its required", () =>
    rolledBack(async (tx) => {
      const rule = "metric_fields.not_the_same_as";
      const offUnder = async (part: object) =>
        (await rulesUnder(tx, part)).get(rule)?.off;
      // metrics_book asks for it when a label shares a word, minimal never.
      expect(await offUnder({ off: ["metric_fields"] })).toBe(false);
      expect(await offUnder({ off: ["metric_not_the_same_as"] })).toBe(true);
      expect(
        await offUnder({ preset: "minimal", off: ["metric_fields"] }),
      ).toBe(true);
      expect(
        await offUnder({ preset: "minimal", off: ["metric_not_the_same_as"] }),
      ).toBe(false);
      expect(await offUnder({ preset: "minimal", off: [rule] })).toBe(true);
      expect(
        (await rulesUnder(tx, { off: [rule] })).get("metric_fields.definition")
          ?.off,
      ).toBe(false);
    }));
});

describe("weakenedBy", () => {
  it("counts each rule of a check in off, and every exception", () =>
    rolledBack(async (tx) => {
      const viewer = asPerson(principals.viewer, { db: tx });
      expect(await weakenedBy(viewer)).toEqual({ rules_off: 0, exceptions: 0 });
      await setConventionsAsAdmin(asPerson(principals.admin, { db: tx }), {
        format: 1,
        off: ["metric_name_form", "metric_base_variant"],
        exceptions: [
          {
            rule: "naming.forbidden_words",
            metric: "sales_ly",
            reason: "Kept.",
          },
        ],
      });
      expect(await weakenedBy(viewer)).toEqual({ rules_off: 3, exceptions: 1 });
    }));
});

describe("getCompanyPartAsAdmin", () => {
  it("answers an admin the stored part of the version in force, and refuses a curator", () =>
    rolledBack(async (tx) => {
      const admin = asPerson(principals.admin, { db: tx });
      expect(await getCompanyPartAsAdmin(admin)).toEqual({
        format: 1,
        preset: "metrics_book",
      });
      await setConventionsAsAdmin(admin, {
        preset: "minimal",
        metric_fields: { category: { required: true } },
      });
      expect(await getCompanyPartAsAdmin(admin)).toEqual({
        format: 1,
        preset: "minimal",
        metric_fields: { category: { required: true } },
      });
      await expect(
        getCompanyPartAsAdmin(asPerson(principals.curator, { db: tx })),
      ).rejects.toMatchObject({ kind: "refused" });
    }));
});

describe("setConventionsAsAdmin", () => {
  it("lets an admin save and refuses a curator and a viewer, storing nothing for them", () =>
    rolledBack(async (tx) => {
      for (const principal of [principals.curator, principals.viewer]) {
        await expect(
          setConventionsAsAdmin(asPerson(principal, { db: tx }), {
            preset: "minimal",
          }),
        ).rejects.toMatchObject({
          kind: "refused",
          message: "You may not edit_conventions this book.",
        });
      }
      expect(await listVersions(tx)).toEqual([]);

      const saved = await setConventionsAsAdmin(
        asPerson(principals.admin, { db: tx }),
        { preset: "minimal" },
      );
      expect(saved.version).toBe(1);
      expect(saved.changes.length).toBeGreaterThan(0);
      const events = await tx
        .select({ kind: event.kind, id: event.element_id })
        .from(event)
        .where(eq(event.kind, "conventions.changed"));
      expect(events).toContainEqual({ kind: "conventions.changed", id: "1" });
    }));

  it("answers an invalid document with the path that is wrong", () =>
    rolledBack(async (tx) => {
      await expect(
        setConventionsAsAdmin(asPerson(principals.admin, { db: tx }), {
          naming: { case: "camel_case" },
        }),
      ).rejects.toMatchObject({
        kind: "invalid",
        detail: { problems: [{ path: "naming.case" }] },
      });
    }));
});
