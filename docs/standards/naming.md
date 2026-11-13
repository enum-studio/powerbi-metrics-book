# Names

A name says what a thing is in the words the business uses, so a newcomer
reads it without a glossary. This file holds two sets of rules:

- **Names in this repository** (code, tables, files, the wire). They bind
  everyone who works on the core.
- **Names in the book** (metrics, labels, descriptions, terms, categories).
  They are Metrics Book's naming standard, copied from it and kept in step,
  and they are the guide of the default conventions, the `metrics_book`
  preset. A company that wants them changes nothing. A company that names
  things its own way changes any rule through the conventions
  (`pbmb conventions edit`), never by forking, and the checks then read
  its rules instead of these. The `minimal` preset checks no name at all.

When an agent curates a company's book, the company's conventions win over
this file: read them first (`pbmb conventions show`, or `get_conventions`
through the connector).

## Names everywhere

- **snake_case, lowercase**, for everything the language allows: SQL,
  Python, YAML keys, file names outside TypeScript, setting keys, metric
  keys, custom field keys, and the JSON of the API and the MCP connector.
- **TypeScript and React follow their language**: camelCase values,
  PascalCase types and components, kebab-case file names. TypeScript code
  reads the wire types as they are, in snake_case, with no layer that
  converts the case (`typescript.md`).
- **Business words, not source words.** The measure a model calls `Spend`
  is filed under `total_marketing_spend_excl_vat`. A newcomer reads
  `current_order_status` where `current_os` would stop them.
- **No abbreviation in a name unless a newcomer reads it as a word.** `vat`,
  `id` and `utm` are words to the reader; `aov`, `cogs` and `roas` are not.
  `dax` is a word to a Power BI reader; `pbi` is not, so code says
  `powerbi` (`powerbi_connection`, `powerbi.tenant_id`). Abbreviations go
  into the aliases instead, where search finds them.
- **Singular for one thing, plural for many.** A table is named for one of
  its rows: `query_result`, `thread_reply`, `audit_event`. A list is
  plural: the route `/api/v1/metrics`, the answer's key `variants`, the CLI
  group `pbmb metrics`. A term, a type or a resource kind is one thing: the
  term `Cohort`, the type `Principal`, the resource kind `dataset`.
- **One name per thing.** Power BI's semantic model is a `dataset`
  everywhere, as its REST API says, never `semantic_model` in one place and
  `model` in the next; a key to it is `dataset_id`. A Power BI object keeps
  Power BI's own id.

## Metric names

A metric's key says what kind of number it is, then what it counts, then its
qualifiers. Its label is the key in words, sentence case, acronyms upper
case: `total_net_sales_excl_vat` is "Total net sales excl VAT".

| Kind | Form | Example |
|---|---|---|
| count | `number_of_<objects>` | `number_of_orders`, `number_of_active_customers` |
| sum of an amount or quantity | `total_<amount>` | `total_net_sales_excl_vat` |
| mean | `average_<thing>[_per_<unit>]` | `average_number_of_items_per_order` |
| median or percentile | `median_<thing>`, `percentile_<n>_<thing>` | `median_time_to_ship_in_hours` |
| part of a whole | `share_of_<thing>` | `share_of_total_net_sales_excl_vat` |
| how often an event happens | `<event>_rate[_<base>]`, the base named when more than one exists | `return_rate_items`, `return_rate_value`, `conversion_rate` |
| two different quantities | `<a>_to_<b>_ratio`, `<name>_ratio` | `marketing_efficiency_ratio` |
| a snapshot | `latest_<kind>...`, `opening_<kind>...` | `latest_total_stock_value_at_cost_excl_vat` |

### Qualifiers, in this order

1. **Deduction stage**: `_after_returns`, `_before_discounts`.
2. **Basis**: `_at_cost`.
3. **Unit**: `_per_order`, `_in_hours`.
4. **VAT**: `_excl_vat` or `_incl_vat`, on every money metric, after every
   other qualifier.

`average_order_costs_per_order_excl_vat` follows the order;
`average_order_costs_excl_vat_per_order` does not.

**Currency** is named only when a dataset holds more than one. Otherwise it
is the metric's format and description, so `total_net_sales_excl_vat` in a
dataset that is all EUR carries no `_eur`. When a currency is named, it
comes after VAT: `total_net_sales_excl_vat_eur`.

### Period comparisons are not metrics

Year over year, month over month and year to date are the same calculation
on a shifted period. A currency conversion is the same calculation in
another unit. So none of them is a metric of its own. In Power BI each is a
measure of its own, and in the book each measure is a variant of its
metric, with its shift on the variant axes (`period`, `comparison`,
`currency`):

- Right: one metric `total_net_sales_excl_vat`, with the measures
  "Net Sales LY" and "Net Sales YTD" filed under it as variants
  (`period: previous_year`, `period: year_to_date`).
- Wrong: `total_net_sales_excl_vat_last_year`, `total_net_sales_ytd`,
  `total_net_sales_excl_vat_dkk`.

A different calculation is a different metric, with its own name.
`total_net_sales_after_returns_excl_vat` subtracts returns, so it is a new
metric, never a variant of `total_net_sales_excl_vat`.

### Labels and descriptions

Power BI has no field for aliases or when to use a measure, so the book
keeps the description in a fixed shape, one field each. `pbmb metrics check`
refuses a metric without a definition, `aliases` (may be `none`),
`when_to_use`, `grain_and_filters`, or a `unit` (`money`, `count`,
`quantity`, `rate`, `ratio`, `duration`). `not_the_same_as` is required
when another metric shares a content word of its label.

```
key:                average_order_value_excl_vat
label:              Average order value excl VAT
definition:         The average net sales of one order: total net sales divided by the number of orders.
aliases:            AOV, Basket size, Average basket value
when_to_use:        To see if customers spend more each time. For how many items they buy, use Average number of items per order.
not_the_same_as:    Average sales price excl VAT, which is per item.
grain_and_filters:  One order. Cancelled and test orders left out. VAT excluded.
unit:               money
category:           sales/orders
```

- The first sentence is the definition, in words a business user would say.
- `Aliases` is where abbreviations live: AOV here, ROAS on
  `return_on_ad_spend`, CAC on `customer_acquisition_cost_excl_vat`. The
  names the company's measures already go by ("Net Sales", "Omsætning")
  are aliases too, so search finds the metric by them.
- `When to use` names the question the metric answers and the metric to use
  for the question next to it.
- `Grain and filters` says what one counted thing is and what is left out.

### What the checks read

Under the `metrics_book` preset each rule above is a conventions key, and a
check reads it from there, never from code:

| Rule | Conventions key | Check |
|---|---|---|
| the kinds and the case | `naming.kinds`, `naming.case` | `metric_name_form` |
| no period or comparison words in a key | `naming.forbidden_words` | `metric_name_comparison` |
| VAT on every money metric | `naming.money_qualifier` | `metric_money_qualifier` |
| the qualifier order | `naming.qualifier_order` | `metric_qualifier_order` |
| the label | `naming.label` | (shown, not checked) |
| the description shape | `metric_fields` | `metric_fields`, `metric_not_the_same_as` |

A key the sync generated from a measure name (`net_sales`) is reported by
`metric_name_generated` until a curator confirms or renames it.

## Columns

The book never renames a Power BI column: the sync mirrors it as the model
names it (`'Sales'[Order Date]`), and agents write DAX with that name. The
book adds what the column means: our `description` beside Power BI's own,
and, for an important dimension, a term. When a company asks its agent to
name new columns in its models, the advice is Metrics Book's, in the
model's own style, and no check reads it: booleans say what true means
("Is cancelled order", "Has discount code"); categories are singular nouns
("Channel", never "Channels"); dates name the object and the event ("Order
created date").

## Terms

Terms are named in sentence case, singular: "Cancelled order", "Channel",
"Cohort". A term is defined in one of two ways.

### Dimension terms, on a column

Most business terms are an important dimension. "Cancelled order" is the
boolean column `'Orders'[Is Cancelled]`, "Channel" is `'Sales'[Channel]`.
Such a term is linked to the columns that back it, in every dataset that
has one (`pbmb terms link <term> <column_id>`):

- Its shape is a metric's: the first sentence is the definition, then
  `aliases` and `not_the_same_as`.
- A categorical one adds `values`: each value and what it means.

"Cancelled order", for example:

```
definition:       True when the order was cancelled before it shipped. False for every order that went ahead, returned or not.
aliases:          Cancelled order, Voided order
not_the_same_as:  Returned item, which shipped and came back.
columns:          'Orders'[Is Cancelled] in Sales, 'Order lines'[Order Cancelled] in Finance
```

And "Channel", a categorical one:

```
definition:       The way the customer reached the shop for this order.
aliases:          Marketing channel, Traffic source
not_the_same_as:  Sales channel (web, app, marketplace, store), which is where the order was placed.
values:           paid_search (search ads), paid_social (social ads), email (newsletters), affiliate (affiliate partners), organic_search (unpaid search), referral (links from other sites), direct (no tracked source).
```

The definition then sits next to the columns it describes, and every metric
whose variants filter or group by one of them links to it.

### Concept terms, only when no column exists

A concept with no column behind it (a cohort, a season, a business rule) is
a concept term: the same shape, with no columns.

```
name:             Cohort
aliases:          Customer cohort
definition:       The customers whose first order fell in the same calendar month.
```

A concept term whose name or alias matches a column already backing a
dimension term is refused: define it on the dimension instead. `term_fields`
refuses a term without a definition, and a categorical dimension term
without values.

## Categories, custom fields and variant axes

A category has a sentence-case `name` ("Orders"), a snake_case `key`
unique among its siblings (`orders`), and a position in the tree. Its path
of keys (`sales/orders`) is how agents and the CLI address it. A metric
sits in exactly one category. A company's custom fields and variant axes
take a snake_case `key` (`owner_team`, `market_scope`), a sentence-case
`label` ("Owner team"), and snake_case values (`home_market`).
