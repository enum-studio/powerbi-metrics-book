import pg from "pg";
import { parse } from "yaml";
import { isDocument } from "./rules.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { roleUrl } from "../../../test/database.js";
import { closeTestPools, principals } from "../../../test/deps.js";
import { rolledBack } from "../../../test/mirror-fixtures.js";
import { resolve, setConventions } from "./store.js";
import { upgradeStoredConventions } from "./upgrade.js";

// The upgrade runs as the migrator, inside the start's migration.
const migrator = new pg.Client({ connectionString: roleUrl("migrator") });
await migrator.connect();
afterAll(() => migrator.end());
afterAll(closeTestPools);
beforeEach(() => migrator.query("delete from conventions"));

const store = (version: number, document: object) =>
  migrator.query(
    "insert into conventions (version, document, set_by) values ($1, $2, 'test-admin')",
    [version, JSON.stringify(document)],
  );

/** What every upgraded part holds: its format, and trust.* pinned as the document had it. */
const upgraded = {
  format: 1,
  trust: { agent_verify_requires: "all_checks", human_verify_from: "browser" },
};

type Row = { version: number; document: object; text: string; xmin: string };
const stored = async () =>
  (
    await migrator.query<Row>(
      "select version, document, document::text as text, xmin::text from conventions order by version",
    )
  ).rows;

describe("upgradeStoredConventions", () => {
  const withPattern = (pattern: string) => {
    const rules = resolve({});
    return {
      ...rules,
      drafting: {
        ...rules.drafting,
        skip: { ...rules.drafting.skip, name_patterns: [pattern] },
        dismiss: [{ name_pattern: pattern, reason: "Internal." }],
      },
    };
  };

  it.each(["^a.b", "foo", "(a|b)"])(
    "leaves an older version with pattern %s unchanged and warns with its version and pattern",
    async (pattern) => {
      const old = withPattern(pattern);
      await store(3, old);
      await store(4, resolve({}));
      const warnings: unknown[] = [];
      expect(
        await upgradeStoredConventions(migrator, {
          warn: (message, fields) => warnings.push({ message, fields }),
        }),
      ).toBe(1);
      expect((await stored())[0]?.document).toEqual(old);
      expect(warnings).toEqual([
        {
          message: expect.any(String) as unknown,
          fields: { version: 3, pattern },
        },
      ]);
    },
  );

  it("rolls back all changes when the newest version has an unconvertible pattern", async () => {
    await store(3, resolve({}));
    await store(4, withPattern("^a.b"));
    const before = await stored();
    await migrator.query("begin");
    try {
      await expect(upgradeStoredConventions(migrator)).rejects.toThrow(
        "Conventions version 4 has the drafting pattern ^a.b, which this release cannot turn into a prefix or a name. Rewrite it as a prefix or a name with `pbmb conventions edit` on the release before this one, then deploy again. Nothing was applied.",
      );
    } finally {
      await migrator.query("rollback");
    }
    expect(await stored()).toEqual(before);
  });

  it("upgrades the previous release's complete document to the metrics_book preset", async () => {
    // Literal from claude/documentation-fields-conventions:conventions/presets/metrics_book.yml.
    const legacy: unknown =
      parse(`# The default conventions: Metrics Book's naming standard and its idea of
# metrics and variants. A company that wants them changes nothing. One that
# names things its own way overrides any key (pbmb conventions edit), and the
# checks then read its rules instead of these.
preset: metrics_book
guide: |
  Our metrics book follows Metrics Book's naming standard: a name says what a thing is in the words the business uses, so a newcomer reads it without a glossary. Read this guide before you name, describe, group or verify anything in the book. The rules below are also data in these conventions, and \`pbmb metrics check\` reports against them.

  ## Metric keys

  A metric's key says what kind of number it is, then what it counts, then its qualifiers, in snake_case: \`number_of_orders\`, never \`orders\`.

  | Kind | Form | Example |
  |---|---|---|
  | count | \`number_of_<objects>\` | \`number_of_orders\`, \`number_of_active_customers\` |
  | sum of an amount or quantity | \`total_<amount>\` | \`total_net_sales_excl_vat\` |
  | mean | \`average_<thing>[_per_<unit>]\` | \`average_number_of_items_per_order\` |
  | median or percentile | \`median_<thing>\`, \`percentile_<n>_<thing>\` | \`median_time_to_ship_in_hours\` |
  | part of a whole | \`share_of_<thing>\` | \`share_of_total_net_sales_excl_vat\` |
  | how often an event happens | \`<event>_rate[_<base>]\`, the base named when more than one exists | \`return_rate_items\`, \`conversion_rate\` |
  | two different quantities | \`<a>_to_<b>_ratio\`, \`<name>_ratio\` | \`marketing_efficiency_ratio\` |
  | a snapshot | \`latest_<kind>...\`, \`opening_<kind>...\` | \`latest_total_stock_value_at_cost_excl_vat\` |

  Use business words, not the model's: the measure a model calls "Spend" is filed under \`total_marketing_spend_excl_vat\`. Write no abbreviation a newcomer would not read as a word: \`vat\` is a word, \`aov\` and \`cogs\` are not. Abbreviations go into the aliases, where search finds them.

  ## Qualifiers, in this order

  1. Deduction stage: \`_after_returns\`, \`_before_discounts\`.
  2. Basis: \`_at_cost\`.
  3. Unit: \`_per_order\`, \`_in_hours\`.
  4. VAT: \`_excl_vat\` or \`_incl_vat\`, on every money metric, after every other qualifier.
  5. Currency, only when a dataset holds more than one, after VAT: \`total_net_sales_excl_vat_eur\`. Otherwise the currency is the metric's format and description, and the key names none.

  \`average_order_costs_per_order_excl_vat\` follows the order; \`average_order_costs_excl_vat_per_order\` does not.

  ## A period comparison or a currency conversion is a variant

  Last year, year to date and growth on last month are the same calculation on a shifted period. A currency conversion is the same calculation in another unit. So none of them is a metric of its own. In Power BI each is a measure of its own; in the book each measure is a variant of its metric, with its shift on the variant axes (period, comparison, currency).

  - Right: one metric \`total_net_sales_excl_vat\`, with the measures "Net Sales LY" and "Net Sales YTD" filed under it as variants (period \`previous_year\`, period \`year_to_date\`).
  - Wrong: \`total_net_sales_excl_vat_last_year\`, \`total_net_sales_ytd\`, \`total_net_sales_excl_vat_dkk\`.

  A different calculation is a different metric, with its own name. \`total_net_sales_after_returns_excl_vat\` subtracts returns, so it is a metric of its own, never a variant of \`total_net_sales_excl_vat\`.

  ## Labels

  The label is the key in words, in sentence case, with acronyms in upper case: \`total_net_sales_excl_vat\` is "Total net sales excl VAT".

  ## Descriptions

  Each metric is described in fixed fields, one each, and every one is required:

  - definition: the first sentence, in words a business user would say.
  - aliases: the other names people use, abbreviations included (AOV, ROAS), and the names the company's measures already go by ("Net Sales"). Set none when there are none.
  - when to use: the question the metric answers, and the metric to use for the question next to it.
  - not the same as: how it differs from another metric whose label shares a content word with its own. Required only then.
  - grain and filters: what one counted thing is, and what is left out.
  - unit: money, count, quantity, rate, ratio or duration.
  - category: where it sits in the tree, as a path of keys (\`sales/orders\`).

  For example:

  \`\`\`
  key:                average_order_value_excl_vat
  label:              Average order value excl VAT
  definition:         The average net sales of one order: total net sales divided by the number of orders.
  aliases:            AOV, Basket size, Average basket value
  when_to_use:        To see if customers spend more each time. For how many items they buy, use Average number of items per order.
  not_the_same_as:    Average sales price excl VAT, which is per item.
  grain_and_filters:  One order. Cancelled and test orders left out. VAT excluded.
  unit:               money
  category:           sales/orders
  \`\`\`

  ## Terms

  A term is a word the business uses that a newcomer needs explained: "Returning customer", "Sign-up attribution", "Cohort", "Channel". It can point to the columns that hold it and the metrics that use it. Whether it has columns is a detail of the term, not what it is.

  Terms are named in sentence case, singular. A term with columns has type \`dimension\`; one with none has type \`concept\`.

  - A term with columns is linked in every dataset that has one: "Channel" is \`'Sales'[Channel]\`. Its shape is a metric's (the definition first, then aliases and not the same as). A categorical one also lists its values, each with what it means. Every metric whose variants filter or group by one of its columns links to it.
  - A term with no column, such as "Cohort", has the same shape, with no columns. Its name or alias must not match a column already backing another term. Add the word to that term as an alias instead.

  ## Columns

  The book never renames a Power BI column: agents write DAX with the column's own name (\`'Sales'[Order Date]\`). The book adds what the column means: a description beside Power BI's own and a term that can point to it.

naming:
  case: snake_case
  kinds:
    - number_of_
    - total_
    - average_
    - median_
    - percentile_
    - share_of_
    - _rate
    - _ratio
    - latest_
    - opening_
  forbidden_words: [last_year, ly, py, ytd, mtd, qtd, yoy, mom, vs, growth]
  money_qualifier:
    required: true
    values: [excl_vat, incl_vat]
    units: [money] # the units that are money
  qualifier_order: [deduction_stage, basis, unit, vat, currency]
  qualifiers: # the words that start each qualifier, read in qualifier_order
    deduction_stage: [after, before]
    basis: [at_cost]
    unit: [per, in_hours]
    vat: [excl_vat, incl_vat]
    currency: [eur, usd, gbp, dkk, sek, nok, chf]
  label: sentence_case
metric_fields:
  definition: { required: true }
  aliases: { required: true }
  when_to_use: { required: true }
  not_the_same_as:
    required: when_label_shares_a_word
    # beside the words of the kinds and the qualifiers, the label words that are not content words
    ignore_words: [a, an, and, or, the, of, to, for, by, on, with]
  grain_and_filters: { required: true }
  unit:
    required: true
    values: [money, count, quantity, rate, ratio, duration]
  category: { required: true }
  custom: []
term_fields:
  definition: { required: true }
  values: { required: when_categorical }
  custom: []
element_fields:
  custom: []
variants:
  axes:
    period:
      values:
        - current
        - previous_year
        - previous_quarter
        - previous_month
        - previous_week
        - previous_day
        - year_to_date
        - quarter_to_date
        - month_to_date
        - previous_year_to_date
        - rolling_12_months
        - other
    comparison: { values: [none, difference, growth_rate, ratio] }
    currency: { values: iso_4217_or_local }
    custom: []
drafting:
  group_by_fingerprint: true
  recognise_time_intelligence: true
  recognise_blank_as_zero: true
  period_words:
    previous_year: [LY, PY, "Last year", "Previous year", "Sidste år"]
    previous_quarter:
      [LQ, PQ, "Last quarter", "Previous quarter", "Sidste kvartal"]
    previous_month: [LM, PM, "Last month", "Previous month", "Sidste måned"]
    previous_week: [LW, PW, "Last week", "Previous week", "Sidste uge"]
    previous_day: [LD, PD, "Last day", "Previous day", Yesterday, "I går"]
  name_hints:
    period: [LY, PY, YTD, MTD, QTD, "Last year", "Sidste år", ÅTD]
    currency: [EUR, DKK, SEK, NOK, USD, Local]
  skip:
    hidden_measures: false
    display_folders: []
    tables: []
    name_patterns: []
  dismiss:
    - name_pattern: "^_"
      reason: "Helper measure (name starts with an underscore)"
trust:
  agent_verify_requires: all_checks
  human_verify_from: browser
# Rule ids, or check names for every rule of a check.
off: []
# Each lets one element keep failing one rule: { rule, reason, and its metric, term, dataset, table or column }.
exceptions: []
`);
    expect(legacy).not.toHaveProperty("format");
    if (!isDocument(legacy))
      throw new Error("The legacy preset is a document.");
    await store(1, legacy);
    expect(await upgradeStoredConventions(migrator)).toBe(1);
    const [row] = await stored();
    expect(row?.document).toEqual({ ...upgraded, preset: "metrics_book" });
    expect(resolve(row?.document)).toEqual(resolve({ preset: "metrics_book" }));
  });

  it("turns each complete document into the company's part, resolving to the same rules", async () => {
    const preset = resolve({});
    const minimal = resolve({ preset: "minimal" });
    const kinds = [...preset.naming.kinds, "_share"];
    const complete = [
      preset,
      { ...preset, naming: { ...preset.naming, kinds } },
      {
        ...minimal,
        metric_fields: {
          ...minimal.metric_fields,
          when_to_use: { required: true },
        },
      },
    ];
    for (const [at, document] of complete.entries())
      await store(at + 1, document);

    expect(await upgradeStoredConventions(migrator)).toBe(3);

    const rows = await stored();
    expect(rows.map((row) => row.document)).toEqual([
      { ...upgraded, preset: "metrics_book" },
      { ...upgraded, preset: "metrics_book", naming: { kinds } },
      {
        ...upgraded,
        preset: "minimal",
        metric_fields: { when_to_use: { required: true } },
      },
    ]);
    expect(rows.map((row) => resolve(row.document))).toEqual(complete);
  });

  it("upgrades nothing twice, and never touches a document that has its format", async () => {
    await store(1, resolve({}));
    const part = {
      format: 1,
      preset: "metrics_book",
      naming: { case: "snake_case" },
    };
    await store(2, part);
    const [, before] = await stored();

    expect(await upgradeStoredConventions(migrator)).toBe(1);
    expect(await upgradeStoredConventions(migrator)).toBe(0);
    const [first, after] = await stored();
    expect(first?.document).toEqual({ ...upgraded, preset: "metrics_book" });
    expect(after).toEqual(before);
  });

  it("moves a pre-format document's checks.off to off", async () => {
    const rest = Object.fromEntries(
      Object.entries(resolve({})).filter(
        ([key]) => key !== "off" && key !== "exceptions",
      ),
    );
    await store(1, { ...rest, checks: { off: ["metric_base_variant"] } });
    expect(await upgradeStoredConventions(migrator)).toBe(1);
    const [row] = await stored();
    expect(row?.document).toEqual({
      ...upgraded,
      preset: "metrics_book",
      off: ["metric_base_variant"],
    });
  });

  it("drops a value set under a rule the document turns off, with a warning, so the part saves", async () => {
    const preset = resolve({});
    const unit = { ...preset.metric_fields.unit, values: ["money", "count"] };
    await store(1, {
      ...Object.fromEntries(
        Object.entries(preset).filter(
          ([key]) => key !== "off" && key !== "exceptions",
        ),
      ),
      checks: { off: ["metric_fields"] },
      metric_fields: { ...preset.metric_fields, unit },
      naming: { ...preset.naming, kinds: ["total_"] },
    });
    const warnings: { message: string; fields: unknown }[] = [];
    const logger = {
      warn: (message: string, fields: Record<string, unknown> = {}) =>
        warnings.push({ message, fields }),
    };
    expect(await upgradeStoredConventions(migrator, logger)).toBe(1);
    const [row] = await stored();
    const part = {
      ...upgraded,
      preset: "metrics_book",
      naming: { kinds: ["total_"] },
      off: ["metric_fields"],
    };
    expect(row?.document).toEqual(part);
    expect(warnings).toEqual([
      {
        message: expect.any(String) as unknown,
        fields: { version: 1, keys: "metric_fields.unit" },
      },
    ]);
    await rolledBack(async (tx) => {
      await setConventions({ db: tx }, principals.admin, part);
    });
  });

  it("leaves an older version it cannot resolve as it was, with one warning naming its version", async () => {
    const old = { preset: "strict", naming: { case: "none" } };
    await store(1, old);
    await store(2, resolve({}));
    const warnings: { message: string; version: unknown }[] = [];
    const logger = {
      warn: (message: string, fields: Record<string, unknown> = {}) =>
        warnings.push({ message, version: fields.version }),
    };
    expect(await upgradeStoredConventions(migrator, logger)).toBe(1);
    expect((await stored()).map((row) => row.document)).toEqual([
      old,
      { ...upgraded, preset: "metrics_book" },
    ]);
    expect(warnings).toEqual([
      { message: expect.any(String) as unknown, version: 1 },
    ]);
  });

  it("stops at a document it cannot read, naming its version, and changes nothing", async () => {
    await store(1, resolve({}));
    await store(2, { naming: { case: "camel_case" } });
    await migrator.query("begin");
    try {
      await expect(upgradeStoredConventions(migrator)).rejects.toThrow(
        /^Version 2 of the conventions cannot be upgraded: .*naming\.case.*\. The api will not start until it can\. Go back to the previous release, save the conventions again with a valid value, then deploy this release\.$/,
      );
    } finally {
      await migrator.query("rollback");
    }
    expect((await stored()).map((row) => row.document)).not.toContainEqual({
      format: 1,
      preset: "metrics_book",
    });
  });
});

it("copies pre-format custom fields to each kind and leaves measures with none", async () => {
  const custom = [
    { key: "owner_team", label: "Owner team", type: "text", required: true },
  ];
  const rules = resolve({});
  const old = {
    preset: rules.preset,
    naming: rules.naming,
    metric_fields: rules.metric_fields,
    term_fields: rules.term_fields,
    variants: rules.variants,
    drafting: rules.drafting,
    trust: rules.trust,
    off: rules.off,
    exceptions: rules.exceptions,
    guide: rules.guide,
  };
  await store(1, { ...old, element_fields: { custom } });
  expect(await upgradeStoredConventions(migrator)).toBe(1);
  const [row] = await stored();
  expect(resolve(row?.document)).toMatchObject({
    dataset_fields: { custom },
    table_fields: { custom },
    column_fields: { custom },
  });
  expect(row?.document).not.toHaveProperty("element_fields");
});
