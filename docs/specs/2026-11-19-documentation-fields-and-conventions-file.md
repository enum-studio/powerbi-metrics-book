# Documentation fields, and the conventions as a file

Written on 2026-11-19 at Martin's asking, for his review. Not built. It follows the Documentation
tabs added the same day (`docs/decisions/look.md`, "A table, a folder and a column have pages"), and
takes its file approach from Metrics Book's project conventions spec
(`enum-studio/metrics-book`, `docs/specs/2026-11-18-project-conventions.md`).

## Goal

Two changes, which meet in one file.

1. **Datasets, tables and columns get documentation fields of their own**, chosen for each kind,
   so an agent knows which dataset to query, what one row of a table is, and what a column's value
   means. Metric variants get no new fields.
2. **A company keeps its conventions in `conventions.yml`** in its deployment repository: only what
   differs from the preset, each rule with an id, rules turned off one at a time, and exceptions with
   a reason, so a house style can be adopted on a book that already has thousands of drafts.

**Done means:**

- `get_dataset` and `list_columns` return the new fields, and the Documentation tabs show them in
  the same order on every kind.
- `pbmb docs check` lists the datasets, tables and columns missing a required field, as
  `pbmb metrics check` does for metrics.
- A deployment with no `conventions.yml` behaves exactly as today.
- `pbmb conventions apply conventions.yml` shows the difference and, for each changed rule, how many
  metrics, terms and elements now fail it, then saves.
- An exception lets one named metric keep failing one rule; an exception that matches nothing fails.
- A company that saved its conventions before a release still gets that release's preset change for
  every key it did not set.
- No key in the conventions takes a regular expression.

## Non-goals

- No editing of documentation in the browser. Curators and agents write it with `pbmb docs`.
- No trust state for an element's documentation. "Last documented" with who and when is enough
  until people ask for review.
- No sample values, lineage or tags on elements.
- No change to the metric's fields.
- No SQL or dbt style rules. Metrics Book's file has them because it owns the SQL; this product
  does not.
- No sharing of one style across companies (an `extends` key).
- No generated Markdown copy of the conventions. The guide, `get_conventions` and the MCP
  instructions already put them in front of agents.

## 1. What exists today

**Documentation.** Every mirror table has `description`, `described_by`, `described_at` and a
`custom jsonb` the sync never writes (`apps/api/src/db/schema/mirror.ts`).
`GET` and `PUT /api/v1/elements/:kind/:id/docs` read and write them, and `pbmb docs show|set` wraps
the routes. The conventions name custom fields in one list, `element_fields.custom`, shared by
datasets, tables, columns and measures. Both presets ship it empty, so the Documentation tabs show a
description and the Details read from Power BI, and nothing more.

**Conventions.** One document per version in the `conventions` table, the newest in force.
`resolve()` in `apps/api/src/services/conventions/store.ts` merges the document over the preset it
names, key by key, arrays whole. But a saved version is stored complete ("A stored version is
complete, so resolving it only fills keys a later release added"), so once a company saves, a
later change to a preset value no longer reaches it. Admins change the document with
`pbmb conventions show|edit|set|diff|validate|export|import|presets` or the Settings screen, and every
change is recorded in `book_change`. A deployment repository carries the document under
`conventions:` in `book.yml`, moved with `pbmb admin export` and `pbmb admin import`; the example in
`examples/sample/book.yml` sets two currency words and nothing else.

**Checks.** Nine checks read the conventions: eight for metrics and `term_fields`
(`METRIC_CHECK_NAMES` and `TERM_CHECK_NAMES` in `conventions/schema.ts`). `checks.off` turns off a
whole check, so `metric_name_form` cannot drop the name kinds and keep the case rule.

**Patterns.** `drafting.skip.name_patterns` and `drafting.dismiss[].name_pattern` are JavaScript
regular expressions. The drafter builds each one with `new RegExp` and tests it against every
measure name (`apps/api/src/services/book/drafter.ts`, lines 552 and 583), so an admin's
backtracking pattern can stall a sync on a long measure name.

## 2. Documentation fields

### The three rules behind them

1. **Facts are read, never written.** Data type, storage mode, relationships, display folder,
   format, hidden and DAX come from the mirror and stay under Details. A field exists only when
   Power BI cannot know the answer.
2. **Each kind answers one question.** A dataset: which model do I query? A table: what is one
   row? A column: what does this value mean?
3. **The metric's words and the terms are reused.** `definition`, `when_to_use`,
   `grain_and_filters` and `unit` mean the same thing on every kind. A column a term backs takes its
   meaning and values from the term, never from a copy.

### The fields

| Kind | Field | Required by default | Example |
|---|---|---|---|
| dataset | `definition` | yes | Orders, returns and stock for the shops and the web shop, from 2024. |
| dataset | `when_to_use` | yes | Sales by day and product. For ad spend, use Marketing. |
| dataset | `owner` | no | Finance analytics |
| dataset | `freshness` | no | Refreshed at 06:00; holds data up to yesterday. |
| dataset | `caveats` | no | The Ship date relationship is inactive: use USERELATIONSHIP for shipped sales. |
| table | `definition` | yes | The order lines of every sale. |
| table | `grain_and_filters` | on fact tables | One order line. Test orders left out. |
| table | `caveats` | no | |
| column | `definition` | on visible columns no term backs | The day the order was placed, in the shop's time zone. |
| column | `unit` | on numeric columns that are not keys | money |
| column | `blank_means` | no | No campaign brought the order. |

`definition` is the element's existing `description`, so nothing written today is lost, and the
API keeps the name `description` on the wire. `unit` takes the same values as the metric's `unit`
(money, count, quantity, rate, ratio, duration), from the conventions. A categorical column's
values belong to its term (`term_fields.values`), not to the column.

The "required when" rules read facts the mirror already has: a table's `kind` (fact, dimension,
date, measures or standalone, from `mirror/read.ts`), a column's `data_type` and `is_hidden`, and a
link in `term_column`. A measures table, a date table and a hidden column ask for nothing.

### Metric variants: no new fields

A variant is the same calculation as its metric, shifted (`docs/standards/naming.md`). Its shift on
the axes (period, comparison, currency and the custom axes) is its structure, and `shift_note`
holds the one difference a variant may have, such as a blank shown as 0. Anything more is a
different calculation, so a different metric. "Which variant do I use?" is answered by the dataset's
`when_to_use`. A variant shows its shift as rows, then its dataset and table, Power BI's description
of the measure, and its DAX, which is now open on the metric's page.

### Storage

The built-in fields are text columns on the mirror tables, as a metric's are on `metric`:
`when_to_use`, `owner`, `freshness` and `caveats` on `powerbi_dataset`; `grain_and_filters` and
`caveats` on `powerbi_table`; `unit` and `blank_means` on `powerbi_column`. Like `description`, the
sync never writes them and `api_rw` writes nothing else of the mirror, so the grants on those
tables gain these columns and nothing more. `custom` stays for each company's own fields.

### Where they appear

- **REST.** The docs route reads and writes the fields; `GET /api/v1/datasets/:id` returns the
  dataset's, and each table's `grain_and_filters`; the column list and column answers return
  `unit` and `blank_means`.
- **MCP.** `get_dataset` carries `when_to_use`, `freshness` and `caveats` beside the description,
  and each table's grain. `list_columns` carries `unit` and `blank_means`. The tool descriptions say
  to read `when_to_use` before picking between datasets.
- **Search.** The fields join the element's search document, as the description does.
- **CLI.** `pbmb docs set` takes `--when-to-use`, `--owner`, `--freshness`, `--caveats`,
  `--grain`, `--unit` and `--blank-means`, refusing a field the kind does not have.
  `pbmb docs check [--dataset <name>]` lists the gaps.
- **Web.** The Documentation tabs read the kind's field list from the conventions, in the order
  of the table above, then the kind's custom fields, then Details.
- **Checks.** `dataset_fields`, `table_fields` and `column_fields` join the check list, reported by
  `pbmb docs check` and counted in `whoami`'s summary.

### In the conventions

`element_fields` gives way to one block per kind. A measure not filed under a metric keeps a
description and no fields.

```yaml
dataset_fields:
  definition: { required: true }
  when_to_use: { required: true }
  owner: { required: false }
  freshness: { required: false }
  caveats: { required: false }
  custom: []
table_fields:
  definition: { required: true }
  grain_and_filters: { required: when_fact }
  caveats: { required: false }
  custom: []
column_fields:
  definition: { required: when_visible_and_no_term }
  unit:
    required: when_numeric
    values: [money, count, quantity, rate, ratio, duration]
  blank_means: { required: false }
  custom: []
```

The `minimal` preset asks for `definition` on datasets and nothing else.

## 3. The conventions as a file

### The file

`conventions.yml` sits at the root of the deployment repository `pbmb init` makes, beside
`book.yml`. The guide moves out of the YAML into `conventions/guide.md`, so it reads and reviews as
Markdown. Every key but `format` is optional, and a key left out keeps the preset's value.

```yaml
format: 1
preset: metrics_book
guide: conventions/guide.md

naming:
  money_qualifier: { values: [excl_vat] }   # we report without VAT

metric_fields:
  custom:
    - { key: owner_team, label: Owner team, type: text, required: true }

dataset_fields:
  owner: { required: true }

drafting:
  name_hints: { currency: [EUR, USD] }
  dismiss:
    - { prefix: "_", reason: Helper measure }

off:
  - naming.qualifier_order

exceptions:
  - rule: naming.kinds
    metric: gmv
    reason: The board reads this name in every report.
```

`pbmb admin export` writes `book.yml` and `conventions.yml`; `pbmb admin import` reads both. A
`book.yml` that still holds `conventions:` imports as before, and export moves it out.

### The database keeps the company's part

A version stores what the company set, not the resolved document. The API resolves it over the
shipped preset when it reads it, so a later release's preset change reaches every key the company
did not set. The upgrade turns each stored version into that overlay by dropping every value equal
to the current preset's. A value that differs stays as the company's, so no rule in force changes on
upgrade. The database stays what the API reads; the file is how people change it and review it.

### Rule ids

A rule's id is the path of the key it reads: `naming.kinds`, `naming.case`,
`naming.money_qualifier`, `metric_fields.when_to_use`, `term_fields.values`,
`column_fields.unit`. The two checks with no key keep their check names as ids:
`metric_name_generated` and `metric_base_variant`. Every finding names its rule id, in
`pbmb metrics check --json`, `pbmb docs check --json` and the check results the web shows.

`pbmb conventions show --json` lists every rule: its id, its value, its source (`preset` or
`company`), the values it allows, whether it is off, and its number of exceptions. The fixed rules
come with their reason.

### Turning a rule off

`off` takes rule ids, and a check name, which turns off every rule of that check. It replaces
`checks.off`, which the upgrade moves into it. Setting a value for a rule that is also off is
refused, so a file says one thing about each rule.

### Exceptions

An exception lets one element keep failing one rule while new ones follow it. It names a `rule`,
exactly one target and a `reason`: one line of at most 200 characters, shown as text.

| Rule | Target |
|---|---|
| `naming.*`, `metric_fields.*`, `metric_*` checks | `metric`: the key |
| `term_fields.*` | `term`: the name |
| `dataset_fields.*` | `dataset`: the name or id |
| `table_fields.*` | `table`: `'<table>'` in a `dataset` |
| `column_fields.*` | `column`: `'<table>'[<column>]` in a `dataset` |

There are no wildcards. An exception that matches nothing fails `pbmb metrics check` and
`pbmb docs check` with `conventions.exception_unused`, so the list only shrinks.

`pbmb conventions apply conventions.yml --baseline --reason "Names in use before the house style"`
writes one exception for each current failure of a rule the file changes. This is how a production
tenant with about 9,000 drafts takes a stricter rule: what exists is listed once, and the check holds
every new name to the rule.

### What stays fixed

Naming one of these as a key, in `off` or in `exceptions` is refused with `conventions.fixed` and the
reason.

| Rule | Why it cannot change |
|---|---|
| The three trust states and what each means | Approval, the checks and every reader of the book depend on them. `trust.human_verify_from` stays a setting (rule 8). |
| A variant's base values, `current` and `none` | A variant is the same calculation shifted; the base is where the shift starts. |
| Unique metric keys and term names | Agents, links and the CLI address them by these. |
| PII | Rules are set on the admin PII page, never in the conventions. |
| `format` | It says how to read the rest. |

### No regular expressions

`drafting.skip.name_patterns` gives way to `name_prefixes` and `names`, and `dismiss[].name_pattern`
to `prefix` or `name`, all compared case-insensitively as text. The upgrade converts `^text` to a
prefix and `^text$` to a name. Any other stored pattern stops the upgrade with its version and the
pattern, for a person to rewrite. The presets ship one pattern, `^_`, which becomes `prefix: "_"`.

### Commands

The existing commands stay. These change or join them:

```bash
pbmb conventions apply conventions.yml --dry-run --json
```

Validates the file, shows the difference against the version in force and, for each changed rule,
how many metrics, terms and elements now fail, then saves unless `--dry-run`. It saves even when
names now fail, so an agent can change the style and fix names in one sitting; the checks are the
gate. It replaces `import`, which stays as another name for it for one release.

```json
{
  "changed_rules": ["naming.money_qualifier", "dataset_fields.owner"],
  "now_failing": { "naming.money_qualifier": 41, "dataset_fields.owner": 5 }
}
```

```bash
pbmb conventions reset naming.money_qualifier
```

Removes the company's setting, its `off` entry and its exceptions for that rule; with no rule
named, everything the company set.

`pbmb conventions export` writes the company's part, and `--resolved` the whole document.
`pbmb conventions diff conventions.yml` exits 1 when the file and the version in force differ, so
the deployment repository's CI catches a change made on the Settings screen and never written back.
`pbmb check` validates `conventions.yml` offline against the shipped schema, as it does `book.yml`.

## 4. Security review

The conventions loosen checks and carry text agents read, so this goes through the security review
in `docs/security/agents.md`, rule 3, and `docs/security/threat_model.md` gains the file.

- Saving stays an admin action (`book:edit_conventions`), as today.
- `off` and exceptions can weaken the book. `pbmb conventions show --json` and `whoami` report how
  many rules are off and how many exceptions exist, so a weakened book shows in review.
- Removing regular expressions removes the one way the conventions could stall a sync.
- The CLI reads the file with its existing safe loader, which refuses anchors and aliases, and every
  path it reads (`guide`) stays inside the deployment folder.
- An exception's reason and the guide are data an agent reads, never instructions it follows
  (agents rule 5); they are shown as text.
- The new documentation columns get grants for `api_rw` only, and a security test proves the sync's
  role cannot write them.

## 5. Delivery order

One migration per branch.

1. **Rule ids, overlay and `show`.** Store the company's part, the upgrade that turns stored
   versions into it, rule ids on every finding, `show` with source. No behaviour change.
2. **`off`, exceptions and the commands.** `off` by rule, exceptions with `--baseline`, `apply`,
   `reset`, `export --resolved`, `diff` exit codes, `conventions.yml` and `conventions/guide.md` in
   `pbmb init`, `pbmb admin export` and `import`.
3. **No regular expressions.** The new drafting keys and the upgrade that converts patterns.
4. **Documentation fields.** The per-kind blocks, the columns and their grants, the three checks,
   REST, MCP, search, `pbmb docs set|check` and the Documentation tabs.
5. **Docs.** The conventions page and `use/browse-the-catalog.md`, the decisions
   (`docs/decisions/book.md`, `docs/decisions/look.md`), the threat model, and an agent eval task
   that picks between two datasets by `when_to_use`.

## Decisions, and when they stop being right

- **Fixed fields for each kind, beside custom ones.** Stops being right if most companies turn
  the built-in fields off.
- **The company's part is stored, and the preset resolved on read.** Stops being right if a preset
  change surprises a company; then a version names its preset's version (`metrics_book@2`).
- **The database is what the API reads, and the file is how people change it.** Stops being right
  when every deployment is run from its repository; then the API could read the file.
- **No regular expressions.** Stops being right if companies need patterns that prefixes and names
  cannot say; then a linear-time engine, never JavaScript's.

## Open questions for Martin

1. Is `owner` a built-in dataset field, or left to each company's custom fields?
2. Should `conventions.yml` stand beside `book.yml`, as above, or stay inside it?
3. Should a table's `definition` be required on every kind of table, or only on facts and
   dimensions?
