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

The guide explains your choices in your own words. The CLI refuses a guide path outside the deployment folder, including one reached through a symlink. It refuses YAML anchors and aliases, and refuses to write through a symlink. The guide and exception reasons are text agents read as data, never instructions.

## Find a rule

```bash
pbmb conventions show --json
```

Each rule has an id, such as `naming.kinds`, `metric_fields.when_to_use` or `column_fields.unit`. The answer lists its value, source (`preset` or `company`), allowed values, whether it is off, and its exception count. Fixed rules come with their reason. Findings in `pbmb metrics check --json` and `pbmb docs check --json` use the same ids.

| Part | What it sets |
|---|---|
| `naming` | Case, kinds such as `total_` or `_rate`, forbidden words, money qualifiers and qualifier order. |
| `metric_fields` | Required definition, aliases, when to use, grain and filters, unit, category, distinctions and custom fields. |
| `term_fields` | Definition, values and custom fields. |
| `dataset_fields` | Definition, when to use, owner, freshness, caveats and custom fields. |
| `table_fields` | Definition, grain and filters, caveats and custom fields. |
| `column_fields` | Definition, unit, what a blank means and custom fields. |
| `variants.axes` | Period, comparison, currency and custom axes. |
| `drafting` | Grouping by calculation, time intelligence, blank as zero, period words, name hints, skipped and dismissed measures. |
| `trust` | What verification needs and who may approve. Changes need a person's browser session. |

Fields take `required: true` or `false`. Some accept a condition: `table_fields.grain_and_filters` accepts `when_fact`, `column_fields.definition` accepts `when_visible_and_no_term`, and `column_fields.unit` accepts `when_numeric`. Read the allowed values in `show --json` before changing a rule. See [Custom fields](/docs/make-it-yours/custom-fields/) for your own fields.

Drafting compares names as text, without regular expressions. `drafting.skip.name_prefixes` skips prefixes and `drafting.skip.names` skips exact names. Each `drafting.dismiss` entry takes either `prefix` or `name`, with a reason. All comparisons ignore case. A drafting change takes effect at the next sync, which moves only what it filed under untouched drafts.

## Turn a rule off or keep an exception

`off` takes a rule id or a check name. For example, `naming.kinds` turns off just the kind rule; `metric_name_form` turns off its case and kind rules. Setting a value and turning that rule off in the same company part is refused.

An exception lets one target keep failing one rule. It needs `rule`, a target and `reason`:

| Rule | Target |
|---|---|
| `naming.*`, `metric_fields.*`, metric checks | `metric`: the key. |
| `term_fields.*` | `term`: the name. |
| `dataset_fields.*` | `dataset`: the name, or id when the name is shared. |
| `table_fields.*` | `dataset` and `table`: the bare table name, such as `Sales lines`. |
| `column_fields.*` | `dataset` and `column`: `'<table>'[<column>]`. |

Targets and names have at most 500 characters. A reason has at most 200 characters on one line, with no control or format characters. There are no wildcards.

`get_conventions` gives agents exception counts per rule, rather than the list. An element's own check results show its `exception` and reason. Apply results and unused exception lists name only targets the caller can see. A principal with `book:edit_conventions` can export the whole stored company part so the file can round-trip through the deployment repository.

An exception is unused if its target is gone or passes the rule without it. `pbmb metrics check` and `pbmb docs check` fail it as `conventions.exception_unused`. Remove it from the file and apply again.

For a book with thousands of drafts, preview a stricter rule before applying it. To keep only the failures that change newly causes:

```bash
pbmb conventions apply conventions.yml --baseline --reason "Names in use before the house style"
```

The CLI writes exceptions into the file before applying it. A target must fail the proposed rule, have passed that rule under the version in force, and be visible to the person applying. Existing failures get no exception. Changing exceptions alone adds none. `--dry-run` previews without writing or saving. Review the added exceptions in git. New targets still have to pass the rule.

`show --json` and `pbmb whoami` report off rules and exception counts so reviewers can see weakened checks. Whole-book counts can include targets the caller cannot see.

## What stays fixed

| Rule | Why |
|---|---|
| The three trust states and what they mean | Approval and readers depend on them. The `trust` settings remain configurable from a browser. |
| Base period `current` and comparison `none` | They are the starting point for a variant's shift. |
| Unique metric keys and term names | Agents, links and the CLI address them by these names. |
| PII | Its rules belong on the admin PII page. |
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
| `pbmb conventions reset naming.money_qualifier` | Removes the company's setting, off entry and exceptions for that rule, restoring the preset. Without an id, resets the whole company part. |
| `pbmb conventions export -o conventions.yml` | Writes the company's part and its guide file. |
| `pbmb conventions export --resolved` | Writes the whole resolved document, with the guide inline. |
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
