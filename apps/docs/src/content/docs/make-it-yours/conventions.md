---
title: Conventions and presets
description: Choose a preset, change any rule, and keep the conventions in git. Every rule, what it changes, and a company that names its measures in Danish.
sidebar:
  order: 1
---

The conventions are your company's rules for the book: how metrics are named, which description fields they need, how variants differ, how the sync groups measures, and what verification asks for. The product ships one default set and you change any part of it without forking. You need the admin role.

The conventions are one document in the database. Every save is a new numbered version, recorded with its before and after in the book's change record (`book_change`), and announced as a `conventions.changed` event in the [change feed](/docs/make-it-yours/change-feed/). The newest version is in force.

The document has two parts. The **guide** is Markdown in your own words, and agents read it first. The **rules** are data that the checks and the drafter read.

## The two presets

`pbmb conventions presets` lists them and marks the one in force.

| Preset | What it is | Use it when |
|---|---|---|
| `metrics_book` (default) | Metrics Book's naming standard and its idea of metrics and variants. Keys say what kind of number it is: `total_net_sales_excl_vat`. Every description field is required. | You have no standard of your own, or want this one. Change nothing. |
| `minimal` | Asks only for a definition and a unit. No rule about names. Drafts are still grouped by fingerprint. | Your measures already have names you want to keep. Start here and add rules. |

A preset is the base. Your document overrides it key by key. Objects merge, and a list you write replaces the preset's list whole. Name the preset with `preset:`, and leave out every key you do not change.

## Every rule and what it changes

**`naming`** applies to a metric's key.

| Key | Changes |
|---|---|
| `case` | `snake_case` makes the check `metric_name_form` refuse anything else. `none` allows any key, spaces included. |
| `kinds` | The words a key must start or end with: `total_`, `average_`, `_rate`. A trailing underscore opens the key, a leading one closes it. An empty list turns the kind rule off. |
| `forbidden_words` | Words a key may not hold, such as `ytd` or `growth`, because a shifted measure is a variant (check `metric_name_comparison`). |
| `money_qualifier` | `required`, the allowed `values` (`excl_vat`, `incl_vat`) and the `units` that count as money. A metric in such a unit must carry one of the values (check `metric_money_qualifier`). |
| `qualifier_order` and `qualifiers` | The order qualifiers must come in, and the words that start each group (check `metric_qualifier_order`). |
| `label` | `sentence_case` or `none`. It appears in the rules agents read. No check reads it. |

**`metric_fields`** is the description shape. Each of `definition`, `aliases`, `when_to_use`, `grain_and_filters` and `category` takes `required: true` or `false`. `not_the_same_as` takes `required: when_label_shares_a_word` (the default), `true` or `false`, and `ignore_words`, the words that do not count as shared. `unit` takes `required` and the allowed `values`. `custom` adds fields of your own ([Custom fields](/docs/make-it-yours/custom-fields/)). The check is `metric_fields`.

**`term_fields`** is the same for terms: `definition`, `values` (`required: when_categorical`, `true` or `false`) and `custom`. The check is `term_fields`.

**`element_fields.custom`** adds custom fields to datasets, tables, columns and measures.

**`variants.axes`** says how a variant may differ from its metric. `period` and `comparison` take lists of values, and `currency` takes `iso_4217_or_local` or a list of codes. `current` must stay among the periods and `none` among the comparisons. `custom` adds axes of your own.

**`drafting`** sets how the sync groups measures. It applies to the whole book at the next sync, and moves only what the sync filed under a draft nobody touched.

| Key | Changes |
|---|---|
| `group_by_fingerprint` | Whether measures with the same calculation become one draft: all of them in one dataset, and across datasets those of one name. |
| `recognise_time_intelligence` | Whether `SAMEPERIODLASTYEAR`, `TOTALYTD` and similar patterns file a measure as a variant. |
| `recognise_blank_as_zero` | Whether a shift or comparison that shows 0 for a blank counts as that shift. Its variant carries a note that says so. A base variant never counts this way. With it off, a ratio of shifted measures still files when its base has the same alternate result, as `DIVIDE([Num LY], [Den LY], 0)` does under `DIVIDE([Num], [Den], 0)`, because that is one calculation. It carries no note. |
| `period_words` | The words in a calendar column's name that give its period, as lists under `previous_year`, `previous_quarter`, `previous_month`, `previous_week` and `previous_day`. A filter on `Date last month` is read as `previous_month` because of `Last month`. These words also suggest merges in `drafts next`. |
| `name_hints` | Words in a measure's name that mark a likely period or currency variant, per language. `drafts next` uses them to suggest merges. |
| `skip` | Measures never drafted: `hidden_measures`, `display_folders`, `tables` and `name_patterns` (regular expressions). |
| `dismiss` | Measures drafted as dismissed, each a `name_pattern` and a `reason`. |

**`trust`** says what verification needs. `agent_verify_requires` is `all_checks` or a list of check names. `human_verify_from` is `browser` or `any`. Only a person's browser session can change a `trust` rule. `pbmb conventions set` and `import` are refused when they would.

**`checks.off`** lists checks to turn off: `metric_name_form`, `metric_name_generated`, `metric_name_comparison`, `metric_money_qualifier`, `metric_qualifier_order`, `metric_fields`, `metric_not_the_same_as`, `metric_base_variant`, `term_fields`.

A change to the conventions changes nothing in the book by itself. The next `pbmb metrics check --all` shows what now fails, and an agent fixes it.

## Change them from the CLI

| Command | Does |
|---|---|
| `pbmb conventions show` | Prints the guide, then each rule as a sentence. Agents run this first. |
| `pbmb conventions export` | Prints the whole document as YAML, preset keys included. |
| `pbmb conventions edit` | Opens the YAML in `$EDITOR`, validates it, shows the difference and asks before saving. Needs a terminal. If anything fails, your file is kept and its path printed. |
| `pbmb conventions set <path> <value>` | Changes one rule, for example `pbmb conventions set naming.case none`. A value that is JSON is read as JSON, anything else as text. A list replaces the old one whole. |
| `pbmb conventions diff <file>` | Shows what a file would change. Saves nothing. |
| `pbmb conventions validate <file>` | Checks a file against the schema. Exits 1 with the API's sentence when it is not valid. |
| `pbmb conventions import <file>` | Replaces the conventions with a file: shows the difference, asks, saves. Add `--yes` to skip the question. |
| `pbmb conventions presets` | Lists the presets and the one in force. |

`import` replaces: a key the file leaves out falls back to the preset, not to the value you had. Run `export` first, change the file, then `import` it.

A key the schema does not know is refused with its path, so a misspelling cannot pass silently.

## Keep them in git

`pbmb admin export -o book.yml` writes the deployment's settings, conventions, role assignments and service accounts to one file. It never holds a secret or an API key, so it can go in git. `pbmb admin import book.yml` shows what would change, asks, and applies it. `pbmb check` validates `book.yml` against the shipped schema before you start a stack.

The conventions sit under the `conventions:` key of `book.yml`. A typical flow is a pull request to the file, review, then `pbmb admin import book.yml`.

## An example: measures named in Danish, with spaces

A Danish company's Power BI models have measures called `Nettoomsætning`, `Antal ordrer` and `Nettoomsætning sidste år`. It wants to keep those names, not translate them into English snake_case. It starts from `minimal`, which has no rule about names, so keys can hold spaces and capitals as they are.

```yaml
preset: minimal
guide: |
  Vi navngiver nøgletal på dansk, som vores Power BI-modeller gør, med mellemrum
  og store bogstaver som i en overskrift: "Nettoomsætning", "Antal ordrer".

  Et sammenligningstal er en variant og ikke et nøgletal: "Nettoomsætning sidste år"
  og "Nettoomsætning ÅTD" hører under "Nettoomsætning".

  Hvert nøgletal har en definition og en enhed. Skriv definitionen som en sætning,
  en forretningsbruger ville sige.
metric_fields:
  aliases: { required: true }
  grain_and_filters: { required: true }
drafting:
  name_hints:
    period: [ÅTD, KTD, MTD, "Sidste år", "Forrige år", "Sidste måned"]
    currency: [DKK, EUR, SEK, NOK, USD, Lokal]
  dismiss:
    - { name_pattern: "^_", reason: "Hjælpemål: navnet starter med en understreg." }
```

Save it as `conventions.yml` and apply it:

```bash
pbmb conventions validate conventions.yml
pbmb conventions diff conventions.yml
pbmb conventions import conventions.yml
```

What this changes:

- Keys are free text. `minimal` already sets `naming.case: none` and turns the name checks off, so a key can hold spaces and Danish letters: `pbmb metrics rename nettoomsætning "Nettoomsætning"` (the sync made the draft key `nettoomsætning`). Quote a key with spaces on the command line.
- `aliases` and `grain_and_filters` become required, on top of the definition and unit that `minimal` asks for.
- `name_hints` suggest `Nettoomsætning sidste år` as a likely variant of `Nettoomsætning` in `pbmb drafts next`. A list replaces the preset's whole, so the hints name every word the company uses.
- A helper measure whose name starts with an underscore is dismissed with a Danish reason.
- The guide is in Danish, so agents write descriptions in Danish.

## Check

```bash
pbmb conventions show
pbmb conventions diff conventions.yml
```

`show` prints your guide first, then rules as sentences: with the example above, no sentence about snake_case or kinds, and `A metric needs these fields: definition, aliases, grain_and_filters, unit.` `diff` prints `No changes.` once the file is in force. After a save, `pbmb metrics check --all` lists which metrics now fail.
