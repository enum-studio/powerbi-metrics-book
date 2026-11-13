# Short list answers in the connector

Status: design approved by Martin in conversation, 2026-11-13. This file is
for his review.

The connector's lists cost an agent too much context. A metric row is about
750 bytes, a variant row 650 and a search hit 800, most of it nulls, empty
arrays, flags at their default and whole parent objects repeated on every
row. This spec makes the connector decide, per kind and per field, what a
row carries and how long each text field may be. It also adds the small
things an agent needs to write DAX without guessing, takes the catalog's
own reads out of the usage report, and words terms as the business's words
rather than column documentation.

## What Martin asked, and what is assumed

Martin, 2026-11-13: lists should use the same "smart cut offs" so that "all
content of each element are not shown in lists", and "you can control length
of the different attributes of the elements in the lists". Terms should not
"sound like column documentation but general terms", such as "Sign up
attribution" and "Returning customers", which "might not fit into a column
but might reference columns and metrics".

Decided with him on 2026-11-13:

- The connector shapes its own rows (approach A below). The REST API, the
  web app and the CLI keep their shapes, gaining only optional fields.
- The small details in sections 4 to 6 are in scope.
- Questions behind an admin setting is a second spec, after this one.

Assumed, and open to correction in review:

- The text limits in section 2.
- `list_relationships` is a connector tool over a service, with no REST
  route: the REST dataset detail already returns every relationship, and
  REST has no 16 KiB bound.
- Catalog reads leave the person's daily row budget as well as the usage
  report (section 7).

## Non-goals

- The REST API's list shapes, the web app and `pbmb --json`. The agent evals
  read `pbmb --json` and stay as they are.
- Letting an agent choose fields per call. Every tool would take more input
  to learn, agents tend to ask for everything, and the text fields would
  still need limits.
- Search by meaning. Words-only search stays weak on phrasing such as
  "excluding" until a deployment sets an embedding provider.
- Questions as an admin setting (Follow-ups).

## 1. What exists today

Every MCP tool passes its service's answer through unchanged
(`apps/api/src/mcp/tools/*.ts`). The services answer in the shape the REST
API serves, and that shape is pinned by the zod response schemas, the
checked-in `apps/api/openapi.json`, the web app's generated
`apps/web/src/api/schema.d.ts` and its typed fixtures, the CLI's column
paths such as `category.path`, and the agent evals. The connector has one
precedent for shaping its own answer: `get_metric` reorders its fields in
`apps/api/src/mcp/tools/read.ts`, recorded in `docs/decisions/connector.md`.

Measured on a production tenant with 46 datasets and about 1,300 metrics:

| Tool | Bytes per row | Where they go |
|---|---|---|
| `list_metrics` | about 750 | a 230-byte category object with its description on every row; `icon: null`, `custom: {}`, `dismissed: false`, `origin` |
| `list_variants` | about 650 | dataset, workspace, measure and metric objects, each with `kind`; the metric is the one the caller named; a full shift object on the base variant |
| `list_columns` | about 330 | the table object on every row, also when filtered by table; `description: null`, `description_pbi: null`, `terms: []`, `removed: false` |
| `search`, a variant hit | about 800 | a path of five objects; `key: null`, `icon: null`, `metric: null`, `score` |
| `get_dataset` on a model with 30 tables | over 16 KiB, cut | every table and relationship repeats `dataset_id`, `synced_at`, `removed_at`, `described_by`, `described_at`, `custom`; the cut leaves broken JSON, and the tool takes no filter to reach the rest |

`docs/decisions/connector.md` measured a metric row at about 300 bytes on
2026-11-05, so rows grow when nothing holds them to a size. Summaries are
cut at 240 characters in four places (`search/query.ts`, `terms.ts` twice,
`metrics.ts`), each in the middle of a word and with nothing saying so.

## 2. The anchor rules

`apps/api/src/mcp/anchors.ts` holds one function per kind of row. Each names
the fields its row carries and the limit of each text field. A field is
listed to be kept, never to be dropped, so a field a service adds later
reaches the connector only when its anchor names it.

- **Text.** A text field longer than its limit is cut at the last word end
  before it, followed by an ellipsis (…), and the row carries
  `<field>_truncated: true`. A row whose text was not cut carries no flag.
  The limits:

  | Field | Characters |
  |---|---|
  | `summary` (metric, term, search hit) | 240 |
  | `description`, `description_pbi` in a list row or a table of `get_dataset` | 160 |
  | a category's `description` | 240 |
  | a shift's `shift_note` | 160 |
  | `excerpt` (threads), `question`, `missing`, `purpose`, `error` | 240 |
  | `dax` in a query log row | 400 |

- **Aliases.** At most 5, with `aliases_truncated: true` when there are more.
- **Nothing to say.** A field that is null, an empty string, an empty array or
  an empty object is left out. So is a flag at its default:
  `is_hidden`, `removed`, `pii`, `reads_selection`, `has_row_level_security`
  and `upvoted` appear only when true, `is_active` only when false. Each
  tool description says which flags appear only when they are set.
- **Parents.** A dataset is `{ id, name }`. A workspace and a table are their
  names. A category is its path (`"sales/orders"`). A metric is its key. A
  parent the caller filtered by is left out of every row: `table` on
  `list_columns` and `list_measures` called with `table`, `dataset` on
  `list_variants` called with `dataset`, `workspace` on `list_datasets`
  called with `workspace`, and `metric` on every `list_variants` row.
- **`kind`.** Only on the rows of a list that mixes kinds: search hits.
- **Order.** A row keeps the order of today's answer, so the fields an agent
  acts on (`id`, `name`, `measure_reference`) come first.

The shared text rule lives in `apps/api/src/services/text.ts`:

```ts
/** text cut at the last word end within max characters, with an ellipsis, and whether it was cut */
export function excerpt(text: string, max: number): { text: string; truncated: boolean };
```

A word end is the last whitespace at or before `max - 1`; text with none is
cut at `max - 1`. The ellipsis counts towards `max`. The four summary cuts
in the services use it too, so REST summaries end on a whole word and the
REST item schemas gain an optional `summary_truncated` (`true` only). The
SQL that reads a summary or an excerpt reads `max + 1` characters, so the
helper can tell a cut from a text of exactly `max`.

## 3. Rows, tool by tool

The fields each anchor carries, in order. "Target" is the most bytes a row
of that kind may take when every text field is at its limit, which
`anchors.test.ts` asserts.

| Tool | Row | Target |
|---|---|---|
| `list_metrics` | `id`, `name` (the key), `label`, `summary`, `unit`, `category` (path), `trust_state`, `dataset_count`, `aliases` | 650 |
| `list_variants` | `id`, `dataset`, `measure` (name), `measure_reference`, `shift`, `reads_selection`, `selection_columns` | 300 |
| `list_columns` | `id`, `name`, `table`, `data_type`, `column_type` (when not `data`), `is_hidden`, `display_folder`, `description`, `description_pbi`, `terms` (names), `pii` | 600 |
| `list_measures` | `id`, `name`, `table`, `display_folder`, `is_hidden`, `description`, `description_pbi`, `metric` (key), `shift`, `pii` | 650 |
| `list_datasets` | `id`, `name`, `workspace`, `reached_through`, `has_row_level_security`, `description`, `removed` | 400 |
| `list_workspaces` | `id`, `name`, `dataset_count`, `description` | 300 |
| `list_apps` | `id`, `name`, `workspace`, `description`, `datasets` (`{ id, name }` each) | 300 plus 70 a dataset |
| `list_terms` | `id`, `name`, `type`, `summary`, `trust_state`, `column_count` (when above 0), `aliases` | 600 |
| `list_categories` | `path`, `name`, `metric_count`, `description`, `children` | 400 without children |
| `search` | `kind`, `id`, `name`, `label`, `summary`, `dataset`, `trust_state`, `match`, `category` (a metric hit's category path, or a category hit's own), `table` and `display_folder` (variant, column and table hits), `metric` (key, variant hits), `aliases` (metric hits) | 700 |
| `list_threads` | `id`, `kind`, `title`, `status`, `excerpt`, `element`, `author_name`, `created_at`, `reply_count`, `upvote_count` (when above 0), `unread_replies` (when above 0), `upvoted` | 700 |
| `list_requests` | `id`, `at`, `principal`, `via`, `question`, `outcome`, `gaps`, `missing`, `elements` | 1,200 |
| `search_query_log` | `id`, `at`, `principal`, `via`, `dataset`, `status`, `purpose`, `dax`, `error`, `row_count`, `duration_ms`, `result_id`, `metric_ids` | 1,500 |

- **A shift** carries only the axes that differ from the base: `period` when
  not `current`, `comparison` and `comparison_period` when the comparison is
  not `none`, `currency` when set, each custom axis that is set, and
  `shift_note`. A base variant's row has no `shift`.
- **`reached_through`** is a list of short strings: `"workspace"`,
  `"app: <name>"` for each app, and `"share"` for a dataset shared with the
  person directly. The share entry no longer repeats the dataset's own id
  and name.
- **Search hits** lose `path`, `key`, `icon`, `score` and `metric: null`.
  The page keeps `counts`, `search_id`, `search_mode` and `note`.
- **`search_query_log`** marks a cut DAX or purpose with `dax_truncated` and
  `purpose_truncated`, and drops `client_id`, `workspace_id`,
  `column_count` and `measure_names`. `get_query` gives the whole entry.
- **`list_requests`** drops `query_ids` and `search_ids`; `get_request` gives
  them.

The page around the rows is unchanged: `items`, `next_cursor`, `total`,
`pii_hidden` and the 16 KiB rule of `docs/decisions/connector.md`.

## 4. `get_dataset` as a schema summary, and `list_relationships`

`get_dataset` answers with what an agent needs to write DAX against the
model, and nothing about the sync:

```
id, name, workspace, apps (names), has_row_level_security, description,
description_pbi, schema_error, synced_at, pii_hidden, open_questions,
accepted_answers, relationships_note, date_tables, tables, relationships
```

- **Removed:** `configured_by` (a person's email address),
  `target_storage_mode`, `endorsement`, `sensitivity_label`, `enabled`,
  `created_date`, `icon`, `removed_at`, `described_by`, `described_at`,
  `relationships_source`, `relationships_read_at`, `schema_changed_at`,
  `workspace_id`, `reached_through`, `custom` when empty. The rules of
  section 2 apply to the rest.
- **`tables`**, each: `name`, `kind`, `is_hidden`, `column_count`,
  `measure_count`, `description`, `description_pbi`, `pii`, and
  `column_names`: at most 5 visible columns, those that take part in a
  relationship first, then A to Z. A personal-data column is never among
  them for a caller without `pii_reader`, as it is left out of the counts
  today.
- **A table's `kind`**, read from the model, never from its name:
  - `measures`: no columns and at least one measure;
  - `date`: it is in `date_tables`;
  - `fact`: on the many side of at least one relationship;
  - `dimension`: on the one side of a relationship and the many side of none;
  - `standalone`: in no relationship.
- **`date_tables`**: each table on the one side of an active relationship
  whose column there has a date type (`DateTime` or `Date`), as
  `{ table, column, joined_by }`, where `joined_by` counts the active
  relationships that end on that column. Most joined first. It answers
  "which date column do I filter on" from the model's own joins.
- **`relationships`**, each: `from_table`, `from_column`, `to_table`,
  `to_column`, `cardinality`, `cross_filtering_behavior` (when not
  `one_direction`), `is_active` (when false). They stay last, as today.

A model too large for one answer is cut at its end, as today, and the cut's
note names `list_relationships`. The new tool:

| Tool | Input | Answer |
|---|---|---|
| `list_relationships` | `dataset`, `table?` (either end), `active_only?`, `cursor?`, `limit?` | relationship rows as above, A to Z by from table, from column, to table, to column; `next_cursor`; `total` on the first page; `pii_hidden` |

Its service, in `apps/api/src/services/mirror/read.ts`:

```ts
export async function listRelationships(
  context: ServiceContext,
  input: { dataset: string; table?: string; active_only?: boolean; cursor?: string; limit?: number },
): Promise<{ items: RelationshipItem[]; next_cursor: string | null; total?: number; pii_hidden?: number }>;
```

It decides access as `getDataset` does: a dataset the caller may not
describe answers as missing, and a relationship on a personal-data column is
left out for a caller without `pii_reader` and counted in `pii_hidden`.
`getDataset` gains `date_tables`, each table's `kind` and `column_names`, all
optional in the REST schema. That makes 32 tools.

## 5. Shorter `get_*` answers

- **`get_metric`** drops `created_at`, `updated_at`, `touched_at`,
  `name_is_generated`, `origin`, `category_id` (the category is its path),
  `icon`, `verified_by` (the id; `verified_by_name` and `verified_at` stay),
  and every field the rules of section 2 leave out. A base variant carries
  `id`, `dataset`, `measure`, `measure_reference`, `format_string`,
  `reads_selection` and `selection_columns`; `period` when not `current`.
  The order rule of `docs/decisions/connector.md` stands.
- **`get_variant`** drops `normalized_expression`, which only matches
  measures to each other and doubles every DAX answer, and `assigned_by`,
  `assigned_at` and `removed`.
- **`get_term`** follows the rules of section 2.

## 6. Filters and small details

- **`name_contains`**, case-insensitive, with `_` and a space counted as the
  same:
  - `list_metrics`: the key, the label and the aliases;
  - `list_terms`: the name and the aliases;
  - `list_columns`, `list_measures`, `list_datasets`: the name.

  The services and the REST routes take it beside `name_prefix`, which they
  keep. The connector's `list_columns` and `list_datasets` take
  `name_contains` in place of `name_prefix`.
- **`total`** on the first page of `list_variants`, `list_terms`,
  `list_datasets`, `list_columns` and `list_measures`, as `list_metrics` has
  it, so an agent can filter before it pages. Optional in REST.
- **Aliases on metric search hits.** `SearchHit` gains optional `aliases` for
  a metric hit, so a words-only hit shows the word it matched.
- **A reconnect link.** When Power BI or Microsoft no longer accepts a
  person's connection, the sentence ends with the connections page's full
  address, from `PUBLIC_BASE_URL`: "Connect Power BI again at
  https://metrics.example.com/settings/connections, then run this again."
  `execute_dax`'s description says to give that link to the person.
- **`execute_dax` reads data, not the model.** Its description says not to
  query `INFO.*` views: `get_dataset`, `list_columns`, `list_measures` and
  `list_relationships` read the model from the catalog.
- **Power BI's markup.** Power BI wraps names in its error text in tags such
  as `<oii>` and `<ccon>`. The client strips the tags and keeps the names.
- **`get_term` when nothing matches** says what `get_metric` says: "No term
  goes by "X". search finds a term by a word, and list_terms lists the terms
  A to Z."

## 7. Catalog reads leave the usage report and the row budget

`readModelView` runs fixed `INFO.VIEW` queries as the caller, to read a
model's columns, measures and relationships. They are logged like a
person's query, so they fill the usage report's "queries without a metric"
and spend the person's daily row budget on reads they never asked for. On
the production tenant the report's first five entries were all such reads.

- `query_log` gains `origin text not null default 'request'`, checked as one
  of `request` and `catalog`, in one migration. `readModelView` writes
  `catalog`.
- The row budget in `services/queries/limits.ts` sums `request` rows only.
- Every count and list in `services/usage/report.ts` reads `request` rows
  only.
- `searchQueryLog` takes `origins?: ("request" | "catalog")[]`. The connector
  asks for `request` only; REST lists both, and its entries gain `origin`.

Catalog reads stay in the log, so an admin still sees every query that
reached Power BI under a person's name. They stay bounded without the
budget: each is a fixed query over the model's own metadata, run only when
the catalog refreshes a model, which its freshness rule and rate limit keep
from repeating.

## 8. Terms are the business's words

A term is a word the business uses that a newcomer needs explained:
"Returning customer", "Sign-up attribution", "Cohort", "Channel". It can
point to the columns that hold it and the metrics that use it. Whether it
has columns is a detail of the term, not what it is. The `type` values
`dimension` and `concept` stay as data; the words around them change.

- **The web app's Terms page** (`apps/web/src/catalog/terms/list.tsx`):
  - lead: "The words the business uses, defined once: Returning customer,
    Sign-up attribution, Cohort. A term can point to the columns that hold
    it and the metrics that use it."
  - empty state: "When a curator defines a term, it shows here."
- **`list_terms`:** "Lists the book's terms, A to Z, as small anchors: the
  words the business uses, such as Returning customer or Sign-up
  attribution. A term can point to the columns that hold it and the metrics
  that use it. Use it to browse; get_term gives one term in full."
- **`get_term`:** "One term in full: what the business means by the word,
  its aliases, what it is not the same as, its values when it has them, the
  columns that hold it and the metrics that use it. Use it when a person
  uses a business word and you need what it means here; list_terms only
  names terms."
- **`docs/standards/naming.md`, Terms:** opens with the paragraph above. The
  two subsections become "A term with columns" and "A term with no column",
  side by side; "Most business terms are an important dimension" and "only
  when no column exists" go. The refusal of a no-column term whose name
  matches a column backing another term stays.
- **The conventions presets** (`conventions/presets/metrics_book.yml`,
  `minimal.yml`, and the CLI's bundled copies through
  `apps/cli/scripts/sync_assets.py`): the guide's "Terms and columns"
  section becomes "Terms", worded as above. `get_conventions` serves it.
- **The CLI's help** (`apps/cli/src/powerbi_metrics_book/commands/terms.py`)
  and the docs pages `use/concepts.md` and `use/for-curators-drafts.md`:
  the same framing.

## 9. Security review

The branch changes the connector, the row budget and what reaches an agent
about personal data, so it gets a security review. Before the pull request,
the reviewer checks that:

- the personal-data tests keep their strength: the anchors keep `id`, `pii`,
  `column_count`, `pii_hidden` and `from_column`, which
  `routes/v1/pii_security_test.ts` asserts on for MCP;
- `column_names` and `list_relationships` hide personal-data columns as
  `get_dataset` does;
- `list_relationships` answers an undescribable dataset as a missing one;
- leaving catalog reads out of the budget lets no caller choose the DAX or
  the dataset of a catalog read.

`docs/security/threat_model.md` records the budget change under the row
budget's control.

## Documents that change

- `docs/decisions/connector.md`: a new section, "A list row is an anchor",
  with what it decides and when it stops being right.
- `docs/specs/2026-10-25-powerbi-metrics-book.md`: the connector's tool
  table (32 tools, `list_relationships`, `get_variant` without the
  normalised DAX, `get_dataset` as above).
- `docs/security/threat_model.md`: section 9.
- `docs/standards/naming.md`, the presets, the CLI's help and the docs pages:
  section 8.
- `apps/docs`: `pnpm --filter @powerbi-metrics-book/docs gen:reference`
  regenerates the MCP, REST and CLI references.
- `apps/api/openapi.json` and `apps/web/src/api/schema.d.ts`, regenerated
  for the optional REST fields.

## How it is tested

Tier 1 beside each change, tier 2 on the changed areas, on real Postgres and
Cerbos with the mock:

- `apps/api/src/services/text.test.ts`: `excerpt` cuts at a word end, adds
  the ellipsis within the limit, flags only a cut, cuts a text with no
  space, and never splits a character outside the Basic Multilingual Plane.
- `apps/api/src/mcp/anchors.test.ts`: each anchor, built from a service row
  whose every text field is at the service's longest: the fields it keeps,
  in order; nulls, empties and default flags left out; `_truncated` flags; a
  filtered parent left out; and its byte target from section 3.
- `apps/api/src/mcp/tools/tools.test.ts`: updated to the anchors.
- `apps/api/src/mcp/result.test.ts`: `get_dataset` on a seeded model of 30
  tables and 60 relationships fits one answer; `list_relationships` pages a
  model of 400.
- `apps/api/src/services/mirror/read.test.ts`: `listRelationships` filters
  by either end and by `active_only`, pages and totals; `date_tables`, table
  kinds and `column_names`; `name_contains` and `total` on datasets, columns
  and measures.
- `apps/api/src/services/mirror/relationships_security_test.ts`: a
  relationship on a personal-data column is hidden and counted for a caller
  without `pii_reader`; `column_names` never holds such a column; an
  undescribable dataset answers as missing.
- `apps/api/src/routes/v1/pii_security_test.ts`: its MCP cases gain
  `list_relationships`. No existing assertion changes.
- `apps/api/src/mcp/connector_surface_security_test.ts`: 32 tools, and
  `anchors.ts` on the import list.
- `apps/api/src/services/queries/limits.test.ts`: catalog rows do not count
  against the budget. `services/usage/report.test.ts`: catalog rows appear
  in no count or list. `services/queries/log.test.ts`: `origins`.
- `apps/api/src/services/book/metrics.test.ts`, `terms.test.ts`,
  `search/query.test.ts`: `name_contains`, `total`, metric hit aliases, and
  summaries cut on a word with `summary_truncated`.
- `apps/api/src/powerbi/execute.test.ts`: the tags stripped; the ended
  connection's sentence names the connections page.
- The web app's Terms page test and the CLI's help dump, for section 8.

Tier 3 (`pnpm check:all`) once, before the pull request.

## Tasks

Eight sudocode issues in six waves, tagged `connector-anchors`. Tasks 1 to 4
each change the REST schema that `openapi.json` and `schema.d.ts` are
generated from, so no two of them run at once.

| Wave | Task |
|---|---|
| 1 | 1. `excerpt`, the four summary cuts and the thread excerpt, `summary_truncated` in REST |
| 1 | 5. Power BI's markup stripped, and the reconnect link |
| 1 | 7. Terms worded as the business's words (section 8, all but the two tool descriptions) |
| 2 | 2. `name_contains`, `total`, metric hit aliases, and `get_term`'s sentence |
| 3 | 3. `listRelationships`, and `date_tables`, table kinds and `column_names` in `getDataset`, with the security test |
| 4 | 4. `query_log.origin`, the budget, the usage report and `origins` |
| 5 | 6. `anchors.ts` and every connector tool on it, `list_relationships`, the tool descriptions |
| 6 | 8. The decision, the main spec, the threat model, the references, and the security review of the branch |

## Follow-ups

- Questions behind an admin setting: its own spec, next. Martin, 2026-11-13:
  the thread tools "only make sense to have if we also add a questions
  feature", and admins should decide whether to turn it on.
- Metrics Book's naming standard words terms the same way, since the two
  products share it.
- An embedding provider on production, which is a setting and a cost for
  the deployment's admin.
