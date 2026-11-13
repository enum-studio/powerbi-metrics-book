---
title: Concepts
description: Metric, variant, draft, trust state, category, term, conventions and the mirror, with one measure followed from the sample tenant to a verified metric.
sidebar:
  order: 1
---

The book is a layer of business meaning on top of your Power BI models. Power BI keeps the measures. The book says which measures are the same number, what that number is called, and how far to trust it.

This page defines each word once. Every other page in this part uses them. The mirror comes last because the rest sits on top of it. One measure from the sample tenant, "Net sales", is followed through all of them.

## Metric

A metric is a business idea with one canonical calculation, such as total net sales excluding VAT. It has a key (`total_net_sales_excl_vat`), a label, a definition, a unit, a category and a trust state. Agents and people ask for a metric by its key, an alias or its id.

A metric holds one or more variants. It does not hold DAX itself.

## Variant

A variant is one Power BI measure in one dataset, filed under a metric. It carries the metric's calculation shifted on up to three axes:

| Axis | Values |
|---|---|
| `period` | `current`, `previous_year`, `previous_quarter`, `previous_month`, `previous_week`, `previous_day`, `year_to_date`, `quarter_to_date`, `month_to_date`, `previous_year_to_date`, `rolling_12_months`, `other` |
| `comparison` | `none`, `difference`, `growth_rate`, `ratio`, with a `comparison_period` that is one of the period values |
| `currency` | empty (the dataset's own), an ISO 4217 code such as `EUR`, or `local` |

A company can add axes of its own (see [Conventions](/docs/make-it-yours/conventions/)). A free `shift_note` explains a shift the values do not name.

Every dataset that holds the calculation has its own base variant: period `current`, comparison `none`, no currency. All base variants of a metric give the same result. A measure the sync read as time-shifted, with no proof of which shift, is filed as period `other` and not as `current`, because `current` would say it shows the current period. It counts as a base for grouping, and until a curator sets its real shift, no measure of the metric computes it unshifted. Last year, year to date and growth on last month are variants, never metrics of their own. A different calculation, such as net sales after returns, is a different metric.

A measure that reads a slicer (`SELECTEDVALUE`, `HASONEVALUE`, `ISFILTERED`, `ISCROSSFILTERED`, `ISINSCOPE`) returns something else in a plain query than on a report page. Its variant is flagged `reads_selection`, and every answer that shows it names the columns to filter in the query.

## Draft

After each sync, the worker groups measures into draft metrics. It groups two measures only when it can show they compute the same thing: it normalises the DAX, expands references to other measures, and compares a fingerprint of the result. It also recognises a small set of time-intelligence patterns (`SAMEPERIODLASTYEAR`, `TOTALYTD`, `DATESYTD`, filters on a calendar table's own columns and similar) and files those measures as variants of the measure they wrap, and a ratio of two measures shifted by one filter as a variant of the base ratio. Variables and brackets that change nothing do not get in the way. It never groups by name alone, and it never guesses a currency.

Everything else stays a separate draft. A wrong merge is worse than a missed one, so a person or an agent merges the rest. A draft is named from its measures, in snake_case, and flagged `name_is_generated` until someone renames it. Anyone who can see one variant reads the metric's name, so measures in two datasets share a draft only under one name, and the queue offers the merge when the same calculation goes by two.

A measure that is not a metric at all (a title string, a format-string helper) is dismissed with a reason and leaves search.

The sync only moves a measure that no metric holds yet, or one it filed itself into a draft nobody touched. A curator's filing is never moved again. A new shift of a measure a curator filed as a base goes under that curator's metric, in the currency and on the custom axes the curator gave its base, unless another calculation already holds that shift there. The book's change history records it, and a curator moves it like any other variant.

**Example.** The sample tenant has three datasets that hold net sales: the Sales dataset has a measure named `Net sales`, Finance calls the same calculation `Revenue`, and Marketing calls it `Net Sales` and spells it with other spacing and a comment. Three names, three datasets, one calculation.

**Example, continued.** These three measures share one fingerprint. `Net sales` and `Net Sales` fold to one name, so the sync makes one draft from them, `net_sales`. Finance's `Revenue` becomes a draft of its own, `revenue`, because someone who reads only Finance must not learn a name from Sales, and the drafts queue offers the two as a merge. The Sales dataset's `Net sales LY`, `Net sales YTD` and `Net sales growth` are filed under `net_sales` as variants with the shifts `previous_year`, `year_to_date` and `growth_rate` against `previous_year`. Finance's `Revenue PY` and `Revenue YTD` go under `revenue`.

## Trust states

| State | Means | How a metric gets there |
|---|---|---|
| `draft` | Made by the sync, or changed since it was verified. Nobody has reviewed it. | The sync makes it. A change through a token to a verified metric puts it back. |
| `agent_verified` | A curator's agent structured it and every check the conventions turn on passes. | `pbmb metrics verify <name>`, refused while a check fails. |
| `human_verified` | A person reviewed it and approved it. | The Approve button on the metric's review page, in a browser session. |

An agent holding a person's CLI or MCP token cannot approve. Under the default conventions only a signed-in browser session can. Changes by token move a metric down: an edit to an `agent_verified` metric makes it a `draft`, and an edit to a `human_verified` metric makes it `agent_verified` if every check still passes, and a `draft` if one fails. A change made through a browser session keeps the state. Every change, by anyone, is a row in the metric's history with the before and after (`pbmb metrics history <name>`).

Read more in [For curators: approving](/docs/use/for-curators-approving/).

## Categories

Categories are a tree of any depth. A metric sits in one category, and its path (`sales/orders`) is how agents and the CLI address it. A category has a sentence-case name and a snake_case key that is unique among its siblings. A category that holds metrics or other categories cannot be deleted.

## Terms

A term is a word the business uses that a newcomer needs explained: "Returning customer", "Sign-up attribution", "Cohort", "Channel". It can point to the columns that hold it and the metrics that use it. Whether it has columns is a detail of the term, not what it is.

A term with columns has type `dimension`; one with none has type `concept`.

- A term with columns, such as "Channel", points to `'Sales'[Channel]` in every dataset that has it. A categorical term lists its values and what each means.
- A term with no column, such as "Cohort", has the same shape, with no columns. Its name or alias must not match a column already backing another term. Link to the existing term instead.

Terms are named in sentence case, singular. A metric links to the terms whose columns its variants filter or group by, so an agent that reads the metric finds the column.

## Conventions

The conventions are the company's rules, kept in the database and changed by admins. They have a guide, in the company's own words, and rules that the checks and the drafter read: how keys are named, which description fields are required, which axes a variant has, how drafts are grouped, and what verification needs. Agents read the conventions before they name, describe, group or verify anything.

The book ships with one set, the `metrics_book` preset, and a lighter one, `minimal`. Change either without touching code: [Conventions](/docs/make-it-yours/conventions/).

## The mirror

The mirror is a read-only copy of what Power BI holds, kept current by the sync: workspaces, apps, datasets, tables, columns, measures and relationships. You do not edit it. The one thing you add is our own description on a dataset, table, column or measure. Power BI's own description is kept beside it, never overwritten, and agents read both. Ours wins where both exist.

A measure removed from Power BI keeps its row, marked removed, and leaves search.

## One metric, start to finish

Under the default conventions, the draft `net_sales` becomes this:

```
key:                total_net_sales_excl_vat
label:              Total net sales excl VAT
definition:         The net amount of all order lines, before returns, excluding VAT.
aliases:            Net sales, Revenue, Turnover
when_to_use:        To see how much was sold. After returns, use Total net sales after returns excl VAT.
not_the_same_as:    Total net sales after returns excl VAT.
grain_and_filters:  One order line. Test orders left out.
unit:               money
category:           sales/orders
```

`net_sales` fails the checks at first: the key has no kind (`total_`), the sync generated it, and the fields are empty. Once the unit is `money` the key also needs a VAT qualifier. After the agent renames it, fills the fields and files it, `pbmb metrics check total_net_sales_excl_vat` passes and `pbmb metrics verify total_net_sales_excl_vat` makes it `agent_verified`. A curator then opens the review page and approves it, which makes it `human_verified`. The steps are in [For curators: structuring drafts](/docs/use/for-curators-drafts/).

When an agent later asks `get_metric` for `total_net_sales_excl_vat`, it gets this text, its trust state, and the measure to use in each dataset: `[Net sales]` in Sales, `[Revenue]` in Finance, `[Net Sales]` in Marketing. It then takes that measure's DAX and does not write its own ([For agents: queries](/docs/use/for-agents-queries/)).

## Check

Read the sample tenant's draft and its variants as the book holds them:

```bash
pbmb search net sales --kind metric
pbmb metrics show net_sales
```

The search lists the metric with its trust state. `metrics show` answers the fields above, the failing checks first, a base variant per dataset with its `measure_reference`, and a count of the other variants by shift. On a book that has been curated, use the key it holds (`total_net_sales_excl_vat`) in place of `net_sales`.
