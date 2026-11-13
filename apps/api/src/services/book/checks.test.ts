import { describe, expect, it } from "vitest";
import type { Conventions } from "../conventions/schema.js";
import { resolve } from "../conventions/store.js";
import {
  type CheckableMetric,
  type CheckableTerm,
  checkMetric,
  checkTerm,
  METRIC_CHECKS,
  wordsComparedWithOtherLabels,
  type MetricCheckContext,
  validateCustomFields,
} from "./checks.js";

const metricsBook = resolve({ preset: "metrics_book" });
const OWNER_TEAM = {
  key: "owner_team",
  label: "Owner team",
  type: "text",
  required: true,
};
const minimal = resolve({ preset: "minimal" });

/** The naming standard's own example: it passes every check under metrics_book. */
function metric(overrides: Partial<CheckableMetric> = {}): CheckableMetric {
  return {
    name: "average_order_value_excl_vat",
    label: "Average order value excl VAT",
    name_is_generated: false,
    definition: "The average net sales of one order.",
    aliases: ["AOV", "Basket size"],
    when_to_use: "To see if customers spend more each time.",
    not_the_same_as: "Average sales price excl VAT, which is per item.",
    grain_and_filters: "One order. Cancelled and test orders left out.",
    unit: "money",
    category_id: "4f4e2b8a-1d7c-4b8e-9a51-2f0c6d3e8b17",
    custom: {},
    ...overrides,
  };
}

const context = (
  conventions: Conventions,
  overrides: Partial<MetricCheckContext> = {},
): MetricCheckContext => ({
  conventions,
  other_labels: [],
  live_base_variants: 1,
  advise: true,
  live_other_variants: 0,
  ...overrides,
});

const failing = (
  conventions: Conventions,
  overrides: Partial<CheckableMetric>,
) =>
  checkMetric(metric(overrides), context(conventions))
    .filter((result) => !result.passed)
    .map((result) => result.check);

describe("metric_money_qualifier", () => {
  it("refuses total_net_sales in money under metrics_book and lets it pass under minimal", () => {
    const totalNetSales = { name: "total_net_sales", label: "Total net sales" };
    expect(failing(metricsBook, totalNetSales)).toEqual([
      "metric_money_qualifier",
    ]);
    expect(failing(minimal, totalNetSales)).toEqual([]);
    // minimal turns the check off, and its rules ask for no qualifier either.
    const check = METRIC_CHECKS.metric_money_qualifier;
    expect(check(metric(totalNetSales), context(minimal))).toBeNull();
  });
});

describe("every metric check under metrics_book", () => {
  it("passes the naming standard's example on every check", () => {
    const results = checkMetric(metric(), context(metricsBook));
    expect(results.map((result) => result.check)).toHaveLength(8);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(failing(metricsBook, { aliases: [] })).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    ["number_of_orders", "count", []],
    ["return_rate_items", "rate", []],
    ["marketing_efficiency_ratio", "ratio", []],
    ["number_of_moments", "count", []],
    ["number_of_local_orders_per_customer", "count", []],
    ["total_net_sales_incl_vat", "money", []],
    ["average_order_costs_per_order_excl_vat", "money", []],
    ["total_net_sales_after_returns_excl_vat_eur", "money", []],
    ["orders", "count", ["metric_name_form"]],
    ["rate_of_returns", "rate", ["metric_name_form"]],
    ["NumberOfOrders", "count", ["metric_name_form"]],
    ["number_of_orders_ly", "count", ["metric_name_comparison"]],
    ["total_sales_last_year_excl_vat", "money", ["metric_name_comparison"]],
    ["total_net_sales", "money", ["metric_money_qualifier"]],
    [
      "total_order_costs_excl_vat_per_order",
      "money",
      ["metric_qualifier_order"],
    ],
    [
      "total_net_sales_excl_vat_eur_after_returns",
      "money",
      ["metric_qualifier_order"],
    ],
  ])("%s in %s fails %j", (name, unit, checks) => {
    expect(failing(metricsBook, { name, unit })).toEqual(checks);
  });

  it.each<Partial<CheckableMetric>>([
    { aliases: null },
    { definition: " " },
    { when_to_use: null },
    { grain_and_filters: "" },
    { unit: null },
    { unit: "dollars" },
    { category_id: null },
    { custom: { owner_team: "Finance" } },
  ])("refuses %o in metric_fields", (overrides) => {
    expect(failing(metricsBook, overrides)).toEqual(["metric_fields"]);
  });

  it("orders a rename of a generated key only when it advises", () => {
    const generated = metric({ name_is_generated: true });
    const check = METRIC_CHECKS.metric_name_generated;
    expect(check(generated, context(metricsBook))).toContain("Rename");
    expect(check(generated, context(metricsBook, { advise: false }))).toMatch(
      /nobody has confirmed it\.$/,
    );
  });

  it.each<[string, string, string]>([
    ["metric_name_form", "orders", "count"],
    ["metric_name_comparison", "number_of_orders_ly", "count"],
    ["metric_money_qualifier", "total_net_sales", "money"],
    ["metric_qualifier_order", "total_order_costs_excl_vat_per_order", "money"],
  ])(
    "states the %s fact with no rename order when it does not advise",
    (check, name, unit) => {
      const row = metric({ name, unit });
      const run = METRIC_CHECKS[check as keyof typeof METRIC_CHECKS];
      expect(run(row, context(metricsBook))).toContain("Rename");
      const said = run(row, context(metricsBook, { advise: false }));
      expect(said).not.toBeNull();
      expect(said).not.toContain("Rename");
      expect(said).toMatch(/\.$/);
    },
  );

  it("refuses a generated key and a metric with no live base variant", () => {
    const generated = failing(metricsBook, { name_is_generated: true });
    expect(generated).toEqual(["metric_name_generated"]);
    const check = METRIC_CHECKS.metric_base_variant;
    const noBase = context(metricsBook, { live_base_variants: 0 });
    expect(check(metric(), noBase)).toContain("no live base variant");
  });

  it("lets a metric holding only other pass the base check, as no measure computes it unshifted", () => {
    const check = METRIC_CHECKS.metric_base_variant;
    const onlyOther = context(metricsBook, {
      live_base_variants: 0,
      live_other_variants: 1,
    });
    expect(check(metric(), onlyOther)).toBeNull();
    const onlyShifts = context(metricsBook, {
      live_base_variants: 0,
      live_other_variants: 0,
    });
    expect(check(metric(), onlyShifts)).toContain("no live base variant");
  });

  it("asks for not_the_same_as when another label shares a content word", () => {
    const passes = (not_the_same_as: string | null, other: string) =>
      METRIC_CHECKS.metric_not_the_same_as(
        metric({ not_the_same_as }),
        context(metricsBook, { other_labels: [other] }),
      ) === null;
    const orderCosts = "Average order costs per order excl VAT";
    expect(passes(null, "Number of orders")).toBe(true);
    expect(passes(null, "Total net sales excl VAT")).toBe(true);
    expect(passes("Per item.", orderCosts)).toBe(true);
    expect(passes(null, orderCosts)).toBe(false);
    expect(passes("", orderCosts)).toBe(false);
    expect(passes(" ", orderCosts)).toBe(false);
  });

  it("lists every label sharing a word while they are few, closest first", () => {
    const failing = METRIC_CHECKS.metric_not_the_same_as(
      metric({ label: "Average order costs", not_the_same_as: null }),
      context(metricsBook, {
        other_labels: ["Order lines", "Order costs per region", "Order costs"],
      }),
    );
    expect(failing).toEqual({
      message:
        '3 other metrics share a content word of the label "Average order costs". Say in not_the_same_as how this metric differs.',
      other_labels: ["Order costs", "Order costs per region", "Order lines"],
    });
  });

  it("puts the closest labels first and counts them when they are many", () => {
    const others = Array.from(
      { length: 40 },
      (_, at) => `Order lines in region ${String(at)}`,
    );
    // By name, the first shares one word and the second has the most others, so only the rank puts them last.
    const far = ["Another order line", "Order costs alpha beta gamma"];
    const close = ["Order costs", "Order costs per region", "Order costs net"];
    const failing = METRIC_CHECKS.metric_not_the_same_as(
      metric({ label: "Average order costs", not_the_same_as: null }),
      context(metricsBook, { other_labels: [...far, ...others, ...close] }),
    ) as { message: string; other_labels: string[] };
    expect(failing.message).toMatch(
      /^45 other metrics share a content word of the label "Average order costs"\. /,
    );
    expect(failing.message).toContain("not_the_same_as");
    expect(failing.message.length).toBeLessThan(400);
    expect(failing.other_labels).toHaveLength(45);
    expect(failing.other_labels.slice(0, 4)).toEqual([
      "Order costs",
      "Order costs net",
      "Order costs per region",
      "Order costs alpha beta gamma",
    ]);
  });

  it("says the same whatever order the labels are read in", () => {
    const labels = Array.from(
      { length: 12 },
      (_, at) => `Order costs ${String(at)}`,
    );
    const failing = (other_labels: string[]) =>
      METRIC_CHECKS.metric_not_the_same_as(
        metric({ label: "Average order costs", not_the_same_as: null }),
        context(metricsBook, { other_labels }),
      );
    expect(failing(labels)).toEqual(failing([...labels].reverse()));
  });

  it("says which words it compares, and none when it will not read other labels", () => {
    const words = (not_the_same_as: string | null, conventions = metricsBook) =>
      wordsComparedWithOtherLabels(
        metric({ label: "Average order costs", not_the_same_as }),
        conventions,
      );
    expect(words(null)).toEqual(["order", "costs"]);
    expect(words(" ")).toEqual(["order", "costs"]);
    expect(words("Per item.")).toEqual([]);
    expect(
      words(null, resolve({ checks: { off: ["metric_not_the_same_as"] } })),
    ).toEqual([]);
    expect(
      words(
        null,
        resolve({
          metric_fields: { not_the_same_as: { required: false } },
        }),
      ),
    ).toEqual([]);
  });

  it("counts the labels that share a word in its sentence, and lists them apart", () => {
    const orders = (other_labels: string[]) =>
      checkMetric(
        metric({ not_the_same_as: null }),
        context(metricsBook, { other_labels }),
      ).find((check) => check.check === "metric_not_the_same_as");
    const label = metric().label;
    expect(orders(["Average order costs per order excl VAT"])).toEqual({
      check: "metric_not_the_same_as",
      passed: false,
      message: `Another metric shares a content word of the label "${label}". Say in not_the_same_as how this metric differs.`,
      other_labels: ["Average order costs per order excl VAT"],
    });
    const many = Array.from(
      { length: 40 },
      (_, index) => `Average order costs ${String(index)} excl VAT`,
    );
    const failing = orders(many);
    expect(failing?.message).toBe(
      `40 other metrics share a content word of the label "${label}". Say in not_the_same_as how this metric differs.`,
    );
    expect(failing?.other_labels).toEqual(many);
  });

  it("counts an empty not_the_same_as as missing when it is always required", () => {
    const always = resolve({
      metric_fields: { not_the_same_as: { required: true } },
    });
    for (const not_the_same_as of [null, "", " "]) {
      expect(failing(always, { not_the_same_as })).toEqual(["metric_fields"]);
    }
    expect(failing(always, {})).toEqual([]);
  });

  it("says what to change, in the conventions' own words", () => {
    const orders = metric({ name: "orders", unit: "count" });
    expect(checkMetric(orders, context(metricsBook))[0]).toEqual({
      check: "metric_name_form",
      passed: false,
      message:
        "The key does not start or end with a kind the conventions name: number_of_, total_, average_, median_, percentile_, share_of_, _rate, _ratio, latest_, opening_ (naming.kinds). Rename it.",
    });
    const order = METRIC_CHECKS.metric_qualifier_order(
      metric({ name: "average_order_costs_excl_vat_per_order" }),
      context(metricsBook),
    );
    expect(order).toContain("Rename it with per before excl_vat.");
  });
});

describe("the same metrics under minimal", () => {
  // Named the way a model names its measures, and described with two fields.
  const asIs = {
    name: "Net Sales LY",
    label: "Net Sales LY",
    aliases: null,
    when_to_use: null,
    not_the_same_as: null,
    grain_and_filters: null,
    category_id: null,
  };

  it("asks only for a definition and a unit, and checks no name", () => {
    const generated = { ...asIs, name_is_generated: true };
    const results = checkMetric(metric(generated), context(minimal));
    expect(results.map((result) => result.check)).toEqual([
      "metric_fields",
      "metric_not_the_same_as",
      "metric_base_variant",
    ]);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(failing(minimal, { ...asIs, definition: "" })).toEqual([
      "metric_fields",
    ]);
    expect(failing(minimal, { ...asIs, unit: null })).toEqual([
      "metric_fields",
    ]);
  });

  it("asks nothing of names in its rules either, with every check on", () => {
    const allOn = resolve({ preset: "minimal", checks: { off: [] } });
    for (const name of ["orders", "total_net_sales", "NumberOfOrders"]) {
      expect(failing(allOn, { ...asIs, name })).toEqual([]);
    }
  });
});

describe("a company's own conventions", () => {
  it("passes a key once the company names its kind", () => {
    const netSalesDkk = { name: "net_sales_dkk", unit: "count" };
    expect(failing(metricsBook, netSalesDkk)).toEqual(["metric_name_form"]);
    const kinds = [...metricsBook.naming.kinds, "_dkk"];
    expect(failing(resolve({ naming: { kinds } }), netSalesDkk)).toEqual([]);
  });

  it.each(["metrics_book", "minimal"])(
    "orders, from %s, only the qualifiers its own qualifier_order places",
    (preset) => {
      const own = resolve({
        preset,
        naming: {
          qualifier_order: ["per", "vat"],
          qualifiers: { per: ["per"], vat: ["excl_vat", "incl_vat"] },
        },
      });
      const order = (name: string) =>
        METRIC_CHECKS.metric_qualifier_order(metric({ name }), context(own));
      expect(order("average_order_costs_excl_vat_per_order")).toContain(
        "puts per (per) after excl_vat (vat)",
      );
      // The preset's deduction stage is not placed, so after_returns is no qualifier here.
      expect(order("total_net_sales_excl_vat_after_returns")).toBeNull();
    },
  );

  it("counts a qualifier its qualifier_order does not place as a content word", () => {
    const sharesBefore = (conventions: Conventions) =>
      METRIC_CHECKS.metric_not_the_same_as(
        metric({ label: "Total sales before returns", not_the_same_as: null }),
        context(conventions, {
          other_labels: ["Number of orders before shipping"],
        }),
      );
    expect(sharesBefore(metricsBook)).toBeNull();
    const unplaced = resolve({ naming: { qualifier_order: ["vat"] } });
    expect(sharesBefore(unplaced)).toMatchObject({
      other_labels: ["Number of orders before shipping"],
    });
  });

  it("gives no result for a check it turns off", () => {
    const formOff = resolve({ checks: { off: ["metric_name_form"] } });
    const orders = metric({ name: "orders", unit: "count" });
    expect(checkMetric(orders, context(formOff))).toHaveLength(7);
    expect(failing(formOff, { name: "orders", unit: "count" })).toEqual([]);
  });

  it("requires its own custom fields on a metric", () => {
    const owned = resolve({ metric_fields: { custom: [OWNER_TEAM] } });
    expect(METRIC_CHECKS.metric_fields(metric(), context(owned))).toBe(
      "Owner team (owner_team) is required. (metric_fields)",
    );
    expect(failing(owned, { custom: { owner_team: "Finance" } })).toEqual([]);
  });
});

describe("validateCustomFields", () => {
  const { custom: fields } = resolve({
    metric_fields: {
      custom: [
        OWNER_TEAM,
        { key: "source", label: "Source", type: "choice", values: ["erp"] },
        { key: "launched", label: "Launched", type: "date" },
        { key: "headcount", label: "Headcount", type: "number" },
        { key: "is_core", label: "Is core", type: "boolean" },
      ],
    },
  }).metric_fields;

  it("accepts values of their type, and leaves optional fields out", () => {
    expect(validateCustomFields(fields, { owner_team: "Finance" })).toEqual([]);
    const full = {
      owner_team: "Finance",
      source: "erp",
      launched: "2026-01-31",
    };
    const more = { ...full, headcount: 3, is_core: true };
    expect(validateCustomFields(fields, more)).toEqual([]);
  });

  it("names each value that is missing, of the wrong type or not a field", () => {
    const wrong = { owner_team: "", source: "sap", launched: "2026-02-30" };
    const more = { ...wrong, headcount: "3", is_core: "yes", tier: 1 };
    expect(validateCustomFields(fields, more)).toEqual([
      "Owner team (owner_team) is required.",
      "Source (source) must be one of erp.",
      "Launched (launched) must be a date written YYYY-MM-DD.",
      "Headcount (headcount) must be a number.",
      "Is core (is_core) must be true or false.",
      "tier is not a custom field the conventions name.",
    ]);
  });
});

describe("term_fields", () => {
  const channel: CheckableTerm = {
    definition: "The way the customer reached the shop for this order.",
    values: [{ value: "email", meaning: "Newsletters" }],
    categorical: true,
    custom: {},
  };
  const passes = (
    term: Partial<CheckableTerm>,
    columns = 1,
    rules = metricsBook,
  ) =>
    checkTerm(
      { ...channel, ...term },
      { conventions: rules, backed_by_columns: columns },
    ).every((result) => result.passed);

  it("asks a categorical dimension term for its values, and a concept term for none", () => {
    expect(passes({})).toBe(true);
    expect(passes({ values: null })).toBe(false);
    expect(passes({ values: [] }, 2)).toBe(false);
    expect(passes({ values: null }, 0)).toBe(true);
    expect(passes({ values: null, categorical: false })).toBe(true);
    expect(passes({ values: null }, 1, minimal)).toBe(true);
  });

  it("asks every term for its definition and its required custom fields", () => {
    const blank = { ...channel, definition: "" };
    expect(
      checkTerm(blank, { conventions: minimal, backed_by_columns: 1 }),
    ).toEqual([
      {
        check: "term_fields",
        passed: false,
        message: "Write its definition. (term_fields)",
      },
    ]);
    const owned = resolve({ term_fields: { custom: [OWNER_TEAM] } });
    expect(passes({}, 1, owned)).toBe(false);
    expect(passes({ custom: { owner_team: "Data team" } }, 1, owned)).toBe(
      true,
    );
  });
});
