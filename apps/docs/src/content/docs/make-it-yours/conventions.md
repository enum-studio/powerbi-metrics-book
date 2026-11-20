---
title: Conventions and presets
description: Keep your company's rules in conventions.yml, preview their effect, and review exceptions.
sidebar:
  order: 1
---

The conventions set your company's rules for names, documentation, variants, drafting and verification. Keep `conventions.yml` beside `book.yml` in your deployment repository. You need `book:edit_conventions` to save changes, which the admin role has by default.

## Start with a preset

`pbmb conventions presets` lists `metrics_book` and `minimal`. `metrics_book` asks for names such as `total_net_sales_excl_vat` and full metric documentation. `minimal` asks for a metric's definition and unit, and a dataset's definition, with no naming rules.

The database stores only the company's part. On read, the API resolves it over the preset: objects merge key by key, and a list replaces the preset's whole list. Leave out what you want to inherit. A later release's preset changes reach keys you did not set. The stored company part pins `trust`, including on upgrade, so a preset change cannot change who may verify or approve.

Every save creates a numbered version and a `book_change` record. The database is what the API reads. The file is what you review and apply.

## A short file

Every key except `format: 1` is optional. Without `preset`, the base is `metrics_book`. Put the guide in a Markdown file inside the deployment folder:

```yaml
format: 1
preset: metrics_book
guide: conventions/guide.md

dataset_fields:
  owner: { required: true }

drafting:
  dismiss:
    - { prefix: "_", reason: Helper measure }

off:
  - naming.qualifier_order

exceptions:
  - rule: naming.kinds
    metric: net_sales
    reason: The board reads this name in every report.
```

The guide explains your choices in your own words. Every agent and person signed in reads it, and `.env` sits in the same folder, so the CLI takes a guide only as a Markdown file inside the deployment folder: its path ends in `.md`, no part of it starts with `.`, and neither the file nor any folder on the way is a symlink. A guide is at most 256 KiB. The CLI reads `conventions.yml` and `book.yml` only from a regular file, not through a symlink. It refuses YAML anchors and aliases, and refuses to write through a symlink. The apply preview gives the guide's size, such as `guide: changed (4.1 KB, was 3.8 KB).`, so check that the size is what you expect. The guide and exception reasons are text agents read as data, never instructions.

## Find a rule

```bash
pbmb conventions show --json
```

Each rule has an id, such as `naming.kinds`, `metric_fields.when_to_use` or `column_fields.unit`. The answer lists its value, source (`preset` or `company`), allowed values, whether it is off, and its exception count. Fixed rules come with their reason. Findings in `pbmb metrics check --json` and `pbmb docs check --json` use the same ids.

## Rule reference

In the tables below, a checked key is also its rule id. A nested setting such as `metric_fields.unit.values` belongs to its parent rule, `metric_fields.unit`. Keys marked "No check id" guide drafting or limit saved values; `off` and exceptions do not take those keys.

### Names

| Key and rule id | What it asks and accepted values | `metrics_book` | `minimal` |
|---|---|---|---|
| `naming.case` | `snake_case` asks for lowercase words joined by underscores; `none` leaves case free. | `snake_case` | `none` |
| `naming.kinds` | A list of kinds. A trailing underscore opens the key (`total_`); a leading underscore follows what it counts (`_rate`, as in `return_rate_items`). A kind must have exactly one of those ends. An empty list asks for no kind. | `number_of_`, `total_`, `average_`, `median_`, `percentile_`, `share_of_`, `_rate`, `_ratio`, `latest_`, `opening_` | `[]` |
| `naming.forbidden_words` | Words or runs of words forbidden in metric keys. An empty list forbids none. | `last_year`, `ly`, `py`, `ytd`, `mtd`, `qtd`, `yoy`, `mom`, `vs`, `growth` | `[]` |
| `naming.money_qualifier` | `required` is `true` or `false`. For a metric whose unit is in `units`, its key must hold one of `values` when required. Both lists take words. | `required: true`, `values: [excl_vat, incl_vat]`, `units: [money]` | `required: false`, both lists empty |
| `naming.qualifier_order` | An ordered list of group keys from `naming.qualifiers`. Qualifiers found in the key must follow this order. | `deduction_stage`, `basis`, `unit`, `vat`, `currency` | `[]` |
| `naming.qualifiers` (No check id; read by `naming.qualifier_order`) | A map from group keys to lists of words that start each qualifier. Every group in the order must have an entry. | See below. | `{}` |
| `naming.label` (No check id) | `sentence_case` advises a label in sentence case; `none` gives no case advice. This is shown, not checked. | `sentence_case` | `none` |

The default qualifier words are:

```yaml
naming:
  qualifiers:
    deduction_stage: [after, before]
    basis: [at_cost]
    unit: [per, in_hours]
    vat: [excl_vat, incl_vat]
    currency: [eur, usd, gbp, dkk, sek, nok, chf]
```

### Metric and term fields

For a field with `required: true`, the check asks for a value. `false` makes it optional. Conditions below ask for it only when the condition holds.

| Key and rule id | What it asks and accepted values | `metrics_book` | `minimal` |
|---|---|---|---|
| `metric_fields.definition` | A definition; `required` is `true` or `false`. | `true` | `true` |
| `metric_fields.aliases` | Other names, or `none` after checking there are none; `required` is `true` or `false`. | `true` | `false` |
| `metric_fields.when_to_use` | Which question it answers; `required` is `true` or `false`. | `true` | `false` |
| `metric_fields.grain_and_filters` | What one counted thing is and what is left out; `required` is `true` or `false`. | `true` | `false` |
| `metric_fields.unit` | A unit from `values` (a list of words); `required` is `true` or `false`. | `true`; see units below. | Same. |
| `metric_fields.category` | A category; `required` is `true` or `false`. | `true` | `false` |
| `metric_fields.not_the_same_as` | A distinction from nearby metrics. `required` accepts `true`, `false` or `when_label_shares_a_word`. The condition asks for a distinction when another metric's label shares a content word. `ignore_words` lists words to leave out, along with kind and qualifier words. | `when_label_shares_a_word`; `ignore_words: [a, an, and, or, the, of, to, for, by, on, with]` | `false`; `ignore_words: []` |
| `metric_fields.custom` | Required values in the metric's custom fields. | `[]` | `[]` |
| `term_fields.definition` | A term's definition; `required` is `true` or `false`. | `true` | `true` |
| `term_fields.values` | Values with their meanings. `required` accepts `true`, `false` or `when_categorical`. The condition asks for values on a categorical term backed by columns. | `when_categorical` | `false` |
| `term_fields.custom` | Required values in the term's custom fields. | `[]` | `[]` |

Both presets allow these metric and column units: `money`, `count`, `quantity`, `rate`, `ratio`, `duration`. Set each kind's `unit.values` to replace its list.

Two metric rules have no key: `metric_name_generated` asks a curator to confirm or rename a key generated by sync; `metric_base_variant` asks for a base variant. Both presets keep the base rule. `minimal` turns off five checks: `metric_name_form`, `metric_name_generated`, `metric_name_comparison`, `metric_money_qualifier` and `metric_qualifier_order`.

A company part with no `off` keeps the preset's list. To bring a check back on, write your own `off` list without it. This replaces the whole preset list.

### Dataset, table and column fields

These checks ask for the book's documentation, not Power BI's description. Hidden tables and columns are exempt from required built-in fields. Date and measures tables are exempt too. A column's key status and a table's kind are worked out from what the caller can see, so documentation failures can differ for a reader without PII access.

| Key and rule id | What `required` asks | `metrics_book` | `minimal` |
|---|---|---|---|
| `dataset_fields.definition` | `true`: define the dataset; `false`: optional. | `true` | `true` |
| `dataset_fields.when_to_use` | `true`: say which questions it answers; `false`: optional. | `true` | `false` |
| `dataset_fields.owner` | `true`: name who owns it; `false`: optional. | `false` | `false` |
| `dataset_fields.freshness` | `true`: explain how fresh it is; `false`: optional. | `false` | `false` |
| `dataset_fields.caveats` | `true`: write its caveats; `false`: optional. | `false` | `false` |
| `table_fields.definition` | `true`: define the table; `false`: optional. | `true` | `false` |
| `table_fields.grain_and_filters` | `true`: explain one row and what is left out; `false`: optional; `when_fact`: required only on a fact table. | `when_fact` | `false` |
| `table_fields.caveats` | `true`: write its caveats; `false`: optional. | `false` | `false` |
| `column_fields.definition` | `true`: define the column; `false`: optional; `when_visible_and_no_term`: required only on a visible column without a linked term. | `when_visible_and_no_term` | `false` |
| `column_fields.unit` | `true`: write a unit; `false`: optional; `when_numeric`: required on a numeric column that is not a key. `values` lists allowed units. | `when_numeric`; units above. | `false`; same units. |
| `column_fields.blank_means` | `true`: explain a blank value; `false`: optional. | `false` | `false` |
| `dataset_fields.custom`, `table_fields.custom`, `column_fields.custom` | Required custom fields only where that kind's definition is required. Each key is its own rule id. | All `[]` | All `[]` |

Under `metrics_book`, a column with a linked term is not asked for required custom fields. Under `minimal`, no table is asked for them.

Every `custom` list takes fields with `key`, `label`, `type` and optional `required` (default `false`). Types are `text`, `number`, `boolean`, `date` and `choice`. Only `choice` takes `values`, a nonempty list. Field keys are unique within their list. See [Custom fields](/docs/make-it-yours/custom-fields/) for examples.

### Variant axes

`variants.axes` has no check id. It limits the values saved on variants. Both presets use the same values:

| Key | Accepted values and preset value |
|---|---|
| `variants.axes.period.values` | A list of words containing `current`. Both presets: `current`, `previous_year`, `previous_quarter`, `previous_month`, `previous_week`, `previous_day`, `year_to_date`, `quarter_to_date`, `month_to_date`, `previous_year_to_date`, `rolling_12_months`, `other`. |
| `variants.axes.comparison.values` | A list drawn from `none`, `difference`, `growth_rate`, `ratio`, containing `none`. Both presets allow all four. |
| `variants.axes.currency.values` | `iso_4217_or_local` (both presets), or a list of ISO 4217 codes such as `EUR`, and `local`. |
| `variants.axes.custom` | A list of `{ key, values }`. Both presets: `[]`. Keys must be unique and cannot be `period`, `comparison` or `currency`. Each values list must be nonempty. |

Custom axis keys and values use lowercase letters, digits and underscores, starting with a letter. Period `current` and comparison `none` cannot be removed: together they mark a base variant.

### Drafting

These keys have no check ids. They guide the next sync's drafts. Sync moves only what it filed under untouched drafts. Booleans accept `true` or `false`. Word lists contain text, without regular expressions.

| Key | What it does | `metrics_book` | `minimal` |
|---|---|---|---|
| `drafting.group_by_fingerprint` | Groups measures with the same calculation into a metric. | `true` | `true` |
| `drafting.recognise_time_intelligence` | Recognises shifted calculations as variants. | `true` | `true` |
| `drafting.recognise_blank_as_zero` | Treats recognised blank-to-zero wrappers as the same calculation. | `true` | `true` |
| `drafting.period_words` | Maps `previous_year`, `previous_quarter`, `previous_month`, `previous_week`, `previous_day` to word lists used to recognise shifts. | Lists below. | Same. |
| `drafting.name_hints.period` | Words that warn a name may hide a period shift. | `LY`, `PY`, `YTD`, `MTD`, `QTD`, `Last year`, `Sidste år`, `ÅTD` | Same except `Sidste år` and `ÅTD`. |
| `drafting.name_hints.currency` | Words that warn a name may hide a currency conversion. | `EUR`, `DKK`, `SEK`, `NOK`, `USD`, `Local` | Same. |
| `drafting.skip.hidden_measures` | Skips hidden measures when `true`. | `false` | `false` |
| `drafting.skip.display_folders` | Skips measures in the exact folders listed. | `[]` | `[]` |
| `drafting.skip.tables` | Skips measures in the exact tables listed. | `[]` | `[]` |
| `drafting.skip.name_prefixes` | Skips measures whose names start with a listed prefix, ignoring case. | `[]` | `[]` |
| `drafting.skip.names` | Skips listed exact measure names, ignoring case. | `[]` | `[]` |
| `drafting.dismiss` | Lists `{ prefix, reason }` or `{ name, reason }`, never both selectors. Matches ignore case and keep a dismissed draft with a reason. | `[{ prefix: "_", reason: "Helper measure (name starts with an underscore)" }]` | `[]` |

Both presets' period words are:

```yaml
drafting:
  period_words:
    previous_year: [LY, PY, Last year, Previous year, Sidste år]
    previous_quarter: [LQ, PQ, Last quarter, Previous quarter, Sidste kvartal]
    previous_month: [LM, PM, Last month, Previous month, Sidste måned]
    previous_week: [LW, PW, Last week, Previous week, Sidste uge]
    previous_day: [LD, PD, Last day, Previous day, Yesterday, I går]
```

### Verification

These keys have no check ids. Both presets use the values below. Changing either needs a person's browser session.

| Key | Values | Both presets |
|---|---|---|
| `trust.agent_verify_requires` | `all_checks`, or a list of check names that must pass before agent verification. An empty list requires none. | `all_checks` |
| `trust.human_verify_from` | `browser` allows human approval only from a browser session. `any` also allows a person's CLI or MCP token. A service account cannot approve. | `browser` |

The check names accepted by `agent_verify_requires` are `metric_name_form`, `metric_name_generated`, `metric_name_comparison`, `metric_money_qualifier`, `metric_qualifier_order`, `metric_fields`, `metric_not_the_same_as`, `metric_base_variant`, `term_fields`, `dataset_fields`, `table_fields`, `column_fields`.

## Turn a rule off or keep an exception

`off` takes a rule id or a check name. For example, `naming.kinds` turns off just the kind rule; `metric_name_form` turns off its case and kind rules. Setting a value and turning that rule off in the same company part is refused.

An exception lets one target keep failing one rule. It needs `rule` (a rule id, never a check name), a target and `reason`:

| Rule | Target |
|---|---|
| `naming.*`, `metric_fields.*`, rules with no key of their own, such as `metric_name_generated` and `metric_base_variant` | `metric`: the key. |
| `term_fields.*` | `term`: the name. |
| `dataset_fields.*` | `dataset`: the name, or id when the name is shared. |
| `table_fields.*` | `dataset` and `table`: the bare table name, such as `Sales lines`. |
| `column_fields.*` | `dataset` and `column`: `'<table>'[<column>]`. |

Names, words and exception targets have at most 500 characters. A reason has at most 200 characters on one line of visible text, with no control or format characters, U+2028 or U+2029. There are no wildcards.

`get_conventions` gives agents exception counts per rule, rather than the list. An element's own check results show its `exception` and reason. Apply results and unused exception lists name only targets the caller can see. A principal with `book:edit_conventions` can export the whole stored company part so the file can round-trip through the deployment repository.

An exception is unused if its target is gone, passes the rule without it, or names a dataset whose name another live dataset shares, even one you cannot see (`ambiguous`). Such an exception applies to nothing. For a shared name, use the dataset id instead. `pbmb metrics check` and `pbmb docs check` fail it as `conventions.exception_unused`. Remove it from the file and apply again. Only a curator gets the unused list: `pbmb docs check` run by anyone else lists missing documentation and says nothing of exceptions. `GET /api/v1/docs/checks` gives `unused_exceptions` to a curator on the first page alone.

For a book with thousands of drafts, preview a stricter rule before applying it. To add an exception for each target you can see that the stricter rule newly breaks:

```bash
pbmb conventions apply conventions.yml --baseline --reason "Names in use before the house style"
```

The CLI shows the exceptions it would add and asks first. Only after you answer yes does it write them into the file and apply it, and if the apply is refused it puts the file back as it was. It refuses a `conventions.yml` that is a symlink. A target must fail the proposed rule, have passed that rule under the version in force, and be visible to the person applying. Datasets, tables and columns fail as that person's `pbmb docs check` shows them, so a column joined only to a PII column they cannot read is no key to them. Existing failures get no exception. Only changes to a rule's value, keys it reads or off state can add exceptions; changing exceptions alone adds none. Omitting exceptions from the file drops them even with `--baseline`. `--dry-run` previews without writing or saving. Review the added exceptions in git. New targets still have to pass the rule.

`show --json` and the MCP `whoami` tool report off rules and exception counts so reviewers can see weakened checks. Whole-book counts can include targets the caller cannot see.

## What stays fixed

| Rule | Why |
|---|---|
| `trust.states`: the three trust states and what they mean | Approval and readers depend on them. The `trust` settings remain configurable from a browser. |
| `variants.base`: base period `current` and comparison `none` | They are the starting point for a variant's shift. |
| `keys.unique`: unique metric keys and term names | Agents, links and the CLI address them by these names. |
| `pii` | Its rules belong on the admin PII page. |
| `format` | It says how to read the file. |

Trying to change these through settings, `off` or exceptions is refused with `conventions.fixed` and its reason.

## Preview, apply and keep in git

```bash
pbmb conventions apply conventions.yml --dry-run --json
```

The answer names changed rules and counts their failures under the proposed conventions. For example:

```json
{
  "changed_rules": ["dataset_fields.owner"],
  "now_failing": { "dataset_fields.owner": 5 },
  "exceptions_added": [],
  "version": null
}
```

`now_failing` counts all failures of each changed rule, including targets outside your view. Apply without `--dry-run` to save after reviewing the difference. A save is allowed while checks fail, so a curator can change rules and then fix the book. `import` remains an alias for one release; use `apply` in new workflows.

| Command | Result |
|---|---|
| `pbmb conventions show` | Shows the resolved conventions and guide. |
| `pbmb conventions show --json` | Lists rule ids, values, sources, allowed values, off status and exception counts. |
| `pbmb conventions set dataset_fields.owner.required true` | Changes one key and saves a version, preserving all company exceptions. Requires `book:edit_conventions`. |
| `pbmb conventions edit` | Opens the conventions in your editor and saves the changes, preserving all company exceptions. Requires `book:edit_conventions`. |
| `pbmb conventions apply conventions.yml` | Previews and saves the file. Add `--dry-run --json` to preview only. |
| `pbmb conventions presets` | Lists the available presets. Anyone signed in may run it. |
| `pbmb conventions reset naming.money_qualifier` | Removes the company's setting, off entry and exceptions for that rule, restoring the preset. Without an id, resets the whole company part. |
| `pbmb conventions export -o conventions.yml` | Writes the whole company part and its guide file. Requires `book:edit_conventions`. |
| `pbmb conventions export --resolved` | Writes the resolved document with every company exception and the guide inline. Requires `book:edit_conventions`. |
| `pbmb conventions diff conventions.yml` | Shows changes and exits 1 when the file differs from the version in force. Use it in the deployment's CI. |
| `pbmb conventions validate conventions.yml` | Validates a file without saving it. |
| `pbmb check` | Checks `conventions.yml` and `book.yml` offline against the shipped schemas. |

`pbmb admin export -o book.yml` writes `book.yml` without conventions and writes `conventions.yml` beside it. `pbmb admin import book.yml` reads both. An older `book.yml` with inline conventions still imports; the next export moves them out.

## Check

```bash
pbmb conventions apply conventions.yml
pbmb conventions diff conventions.yml
pbmb metrics check --all
pbmb docs check
```

After applying, `diff` exits 0 and prints `No changes.` The checks list the book entries that still need work and any unused exceptions.
