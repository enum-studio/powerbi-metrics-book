# PII marking and turning datasets on or off

Taken 27 October 2026, spec fast. The next build after v1 (PR #1,
`build/v1`), built on `build/pii-and-datasets`. Martin asked for two things
from the setup he runs at a client: an admin marks Power BI columns as
personal data (PII) from the CLI, so people without PII access cannot reach
them; and an admin turns single datasets on or off. The client system was
read for what it does and where it falls short; none of its code or names
is used here.

## Goal

- **PII rules.** An admin marks a column, a measure or a whole table as
  PII by name, with `pbmb admin pii`. A rule applies in every dataset that
  has a table and column of that name, including datasets created later.
- **PII access is a role.** Only people holding the shipped role
  `pii_reader` see or query PII. Admins do not get it by being admins, and
  no service account ever gets it.
- **Hidden, then refused.** For everyone else, PII columns and measures are
  missing from every metadata answer, are never in the search index, and a
  query that uses one is refused before Power BI is called.
- **Datasets on or off.** An admin turns a dataset off with
  `pbmb admin datasets off`. An off dataset is gone from every surface for
  everyone and cannot be queried; the sync keeps reading it, so turning it
  back on is instant. A setting says whether a dataset the sync finds for
  the first time starts on or off.
- **One way in, two front ends.** Everything goes through the REST api. The
  CLI uses it now; the admin screens of the catalog phase will use the same
  endpoints, so a person can mark PII in the browser. Every rule records
  who set it and from where (`cli`, `browser`, `mcp`, `api`).

## Non-goals

- Masking or filtering values. Rows are never changed; a query is answered
  or refused. `docs/decisions/powerbi.md` already rules out filtering rows
  in the product.
- Replacing Power BI's object level security. Queries run with the
  person's own token, so a company that uses object level security keeps
  it. PII rules are for the companies that do not.
- Per-dataset exceptions to a rule. Martin chose name rules without
  overrides (27 October). A column rule may still override its table's rule
  (below), because that is one table, not one dataset.
- Admin screens. They come with the catalog phase; this build ships the
  REST api and the CLI.
- Purging stored results when a rule changes. A stored result is readable
  only by the person who ran it and expires within 72 hours
  (`results.ttl_hours`).
- Inferring PII through measures. A model measure that aggregates a PII
  column, such as `DISTINCTCOUNT(Customer[Email])`, stays usable: its author
  decided it returns a count. Marking the measure itself covers the rare
  measure that returns the values.

## Decisions taken

1. **Rules by name, not flags by column id** (Martin, 27 October). One rule
   `Customer[Email]` covers the twelve datasets that copy the table and the
   one made next month. A flag per column id leaves every new copy open.
2. **Three rule kinds**: `column` (table and column), `measure` (table and
   measure) and `table` (every column of the table, now and later). A table
   rule does not cover measures, because a measure's home table is often
   arbitrary.
3. **A rule says PII or not PII.** `pii: false` records that a person
   reviewed the name and cleared it, which keeps it out of
   `pbmb admin pii suggest`. A column rule beats its table rule: a `table`
   rule on `Customer` and a `column` rule `Customer[Country]` with
   `pii: false` leave Country visible.
4. **Names match case- and width-insensitively**, as DAX does, under one
   fold defined in SQL only (`foldSql`, decision 12).
5. **New datasets start on, through a setting** (Martin, 27 October):
   `powerbi.datasets.new`, `on` or `off`, shipped as `on`. A large tenant
   sets `off` and turns datasets on one at a time.
6. **A whole-table reference to a table with PII columns is refused**
   (Martin, 27 October), even when it is only filtered:
   `FILTER(Customer, ...)` and `EVALUATE Customer` are both refused for a
   person without `pii_reader`, with a message saying to use the table's
   columns instead. `EVALUATE Customer` can then never leak.
7. **Off is enforced in code, not in Cerbos.** A deployment's own policies
   can widen who sees a dataset; no policy can show an off dataset. The
   same holds for PII: the role decision is Cerbos's (`pii:read`), but what
   is hidden for someone without it is fixed in code.
8. **The admin dataset list shows every live dataset** with its workspace,
   on or off, and counts, whatever the admin's own Power BI access. An admin
   who turns datasets on or off has to see them; the list holds names, not
   data. The existing `custom.queries_off` rule (queries off, metadata
   visible) stays, documented as the lighter switch.
9. **Refusals are audited.** A refused query writes an `audit_event` deny
   row naming the PII references, as the CSV link denials do.
10. **The query log keeps naming an off dataset** to the entry's owner and
    to admins. It names only what they already knew and holds no data.
11. **`pii_reader` is never assigned to everyone in the tenant or an email
    domain**, only to a person or a group (a database CHECK, as for
    `admin`). Otherwise it would undo the refusal of `pii_reader` as
    `access.default_role`.
12. **Every name comparison goes through `foldSql`**: NFKC, `lower()`, then
    ß to ss, ſ to s, ı to i and ς to σ. The metadata filters, the unique
    index on `pii_rule` and `piiNamesOf` use it in SQL; the query check folds
    DAX names with `foldNames`, which asks the database, so no second
    definition exists in JavaScript. `lower()` folds non-ASCII letters only on
    a database whose `LC_CTYPE` is not `C`; the shipped images use
    `en_US.utf8`.
    A Postgres major or glibc upgrade can change the fold under the index,
    and the next start of the api rebuilds it
    (`apps/api/src/db/sql/collation.sql`). The rule lookups fold every rule
    afresh and do not read the index by the fold, so until then they miss
    nothing, and two rules that fold alike leave reads working, with PII
    winning.
13. **A rule change is audited after its commit**, as every admin change is,
    so a failed audit write leaves the rule set.

## Data

Both changes go into the one regenerated migration (`pnpm db:generate`,
which rebuilds `apps/api/drizzle/0000_*.sql`).

```
pii_rule(
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('column', 'measure', 'table')),
  table_name    text not null,
  name          text,             -- null exactly when kind = 'table' (CHECK)
  pii           boolean not null,
  note          text,             -- at most 500 characters (CHECK)
  set_by_kind   text not null,    -- principal kind
  set_by_id     text not null,    -- principal id
  set_via       text not null,    -- 'browser' | 'cli' | 'mcp' | 'api'
  set_at        timestamptz not null default now(),
  unique index on (kind, fold(table_name), fold(coalesce(name, '')))
)
```

- `fold` is the `foldSql` expression; Postgres 13 and later mark
  `normalize()` immutable, so it can stand in an index.
- `setRule` composes names to NFC before it checks their length and
  whitespace, so a name that grows past 200 is `invalid`.

- `table_name` and `name` are at most 200 characters each (CHECK), and
  hold no NUL.
- Grants: `api_rw` select, insert, update, delete; `worker_rw` select (the
  search documents read it); `audit_writer` none. Declared in
  `apps/api/src/db/schema/pii.ts` with `declareGrants`, like the other
  tables.

```
powerbi_dataset.enabled  boolean not null default true
```

- `apiUpdates("relationships_source", "relationships_read_at", "enabled")`
  in `mirror.ts`, so the api may change it.
- The sync sets it only when it inserts a dataset, from
  `powerbi.datasets.new`, and never names it on update. `upsert()` in
  `apps/api/src/services/sync/store.ts` gains an `insertOnly` option: values
  written on insert and left out of the conflict update.

Setting, in `apps/api/src/services/settings/registry.ts`:

```ts
"powerbi.datasets.new": {
  schema: z.enum(["on", "off"]),
  default: "on",
  description: "Whether a dataset the sync finds for the first time starts on or off.",
}
```

## Access

- `SHIPPED_ROLES` becomes `["viewer", "curator", "admin", "pii_reader"]`.
  `pii_reader` grants nothing else, so a person usually holds it beside
  `viewer` or `curator`.
- A new resource kind `pii` (`ResourceKind` in `apps/api/src/context.ts`),
  one resource `{ kind: "pii", id: "pii", attr: {} }` exported as `PII`
  from `apps/api/src/services/pii/rules.ts`, with one action, `read`.
  Policy `access/policies/pii.yaml` allows `read` to `pii_reader`; tests
  in `access/tests/pii_test.yaml` cover each shipped role.
- `beyondServiceAccounts` in `apps/api/src/services/access/cerbos.ts`
  refuses `pii` to service accounts, whatever a policy says.
- Two admin actions, `manage_pii` and `manage_datasets`. `admin.yaml`
  already gives `*` to admin; `access/tests/admin_test.yaml` lists both.
- Off datasets, in `createAccess`:
  - `check()` returns false for a `dataset` resource whose `attr.enabled`
    is false, for every action. A dataset resource without a boolean
    `enabled` throws, as a principal without its Power BI lists does, so a
    caller that forgot the attribute fails loudly.
  - `describableDatasets()` returns `(<plan condition> and powerbi_dataset.enabled)`.
  - Every place that builds a dataset resource adds `enabled`:
    `services/queries/execute.ts` (`describedDataset`),
    `services/mirror/read.ts` (around 359) and any other the type check
    finds.

## The PII module

`apps/api/src/services/pii/` holds the rules and what every surface asks.

```ts
export type PiiRuleKind = "column" | "measure" | "table";
export type PiiRule = {
  id: string; kind: PiiRuleKind; table_name: string; name: string | null;
  pii: boolean; note: string | null;
  set_by_kind: string; set_by_id: string; set_via: string; set_at: string;
};

/** Whether the caller may see PII: Cerbos pii:read, asked once per context. */
export function readsPii(context: ServiceContext): Promise<boolean>;

/** SQL over powerbi_column joined to powerbi_table (aliases as given): true when the column is PII. */
export function piiColumn(column: typeof powerbiColumn, table: typeof powerbiTable): SQL;

/** SQL over powerbi_measure joined to powerbi_table: true when a measure rule marks it. */
export function piiMeasure(measure: typeof powerbiMeasure, table: typeof powerbiTable): SQL;

/**
 * The key every name is compared under, in SQL only:
 * replace(replace(replace(replace(lower(normalize(expr, NFKC)),
 *   'ß', 'ss'), 'ſ', 's'), 'ı', 'i'), 'ς', 'σ').
 * Analysis Services resolves names under the model's collation (usually case-
 * and width-insensitive); this approximates that, verified only against the mock.
 */
export function foldSql(expr: SQL | AnyColumn): SQL<string>;

/** Folds names with foldSql by asking the database; the order is kept. */
export function foldNames(db: Db, names: string[]): Promise<string[]>;

/**
 * The PII names of one dataset for the query check, every key folded by
 * foldSql, read in one REPEATABLE READ read-only transaction.
 */
export function piiNamesOf(db: Db, dataset_id: string): Promise<{
  // Each NamesByTable maps a table to the names in it: Map<string, Set<string>>.
  // No "table[name]" string keys, since names may hold brackets.
  columns: NamesByTable;       // synced PII columns
  measures: NamesByTable;      // synced PII measures
  ruleColumns: NamesByTable;   // every pii = true column rule
  ruleMeasures: NamesByTable;  // every pii = true measure rule
  // Every pii = true table rule's table, mapped to the names its
  // pii = false column rules clear (from pii_rule alone).
  ruleTables: NamesByTable;
  knownMeasures: NamesByTable; // every synced measure
  // For `[name]`: names of synced PII columns and measures, and the name
  // of every pii = true column or measure rule, synced or not.
  bare: Set<string>;
  // Tables holding a synced PII column, every table a pii = true table
  // rule names, and every table a pii = true column rule names.
  tables: Set<string>;
}>;
```

Rules are global, so the rule sets carry tables the dataset may lack; an
extra key is harmless.

A column is PII when its column rule says so, or, with no column rule, its
table rule says so: `coalesce(column_rule.pii, table_rule.pii, false)`.

Service functions, each audited with `audited()` from
`services/admin/guard.ts` and requiring `admin:manage_pii`:

```ts
listRules(context, filter: { pii?: boolean }): Promise<PiiRule[]>;
setRule(context, input: { kind; table_name; name?; pii; note? }):
  Promise<{ rule: PiiRule; columns: number; measures: number; datasets: number }>;
removeRule(context, id: string): Promise<void>;
suggest(context, filter: { dataset?: string }):
  Promise<Array<{ dataset_id; dataset_name; table_name; column_name; matched: string }>>;
```

- `setRule` upserts on the unique key and returns how many live columns,
  measures and datasets it now covers. The audit row is
  `admin.pii_rule.set` with `before` and `after`; removal is
  `admin.pii_rule.remove`.
- After a change, the matching columns and measures are written to
  `book_change` (`recordBookChange`, action `pii_changed`) in the same
  transaction, which queues the embed job for exactly those elements.
- `suggest` lists live columns that no rule covers and whose name the
  heuristic matches. It only suggests; nothing is marked without a person
  or agent calling `setRule`. The heuristic normalises the name to
  lower snake case and matches:
  - anywhere in the name: `first_name`, `last_name`, `full_name`,
    `phone_number`, `mobile_number`, `date_of_birth`, `birth_date`,
    `social_security`, `national_id`, `passport`, `iban`, `ip_address`;
  - as a whole word of the name: `email`, `phone`, `mobile`, `address`,
    `street`, `birthday`, `ssn`, `cpr`;
  - and drops a word match when the name starts with `is_` or `has_`, or
    ends with `_count`, `_type`, `_category`, `_country`, `_city`, `_zip`
    or `_domain`. `name` and `city` alone are not matched.

## What a person without `pii_reader` gets

Each surface asks `readsPii` once and, when false, filters in its SQL:

| Surface | Change |
|---|---|
| `list_columns` (`mirror/read.ts`) | PII columns left out; the answer gains `pii_hidden: <count>` |
| `get_dataset` | table column counts leave PII columns out; relationships with a PII column at either end are left out, judged by the rules alone (a column rule, else a `pii = true` table rule) so a column the mirror has not synced counts; `pii_hidden` as above |
| `list_measures` | PII measures left out, with `pii_hidden` |
| element docs (`book/docs.ts`) for a PII column or measure | `not_found`, the same answer as a missing element |
| `get_term`, `list_terms` | PII backing columns left out |
| `get_variant`, `list_variants`, `get_metric` | a variant whose measure is PII is left out; `selection_columns` drops PII columns |
| curator drafts (`book/drafts.ts`) | drafts of PII measures left out |
| search | PII columns and measures are never indexed, for anyone (below) |
| `list_columns`, `list_measures`, `get_dataset` tables, for a person who has `pii_reader` | nothing hidden; items a rule covers carry `pii: true` (below) |
| query log | unchanged: it holds DAX, never result values |
| threads | a thread on a PII column or measure is not shown, and cannot be started, by a person without the role; the rest is free text, never result values |

`pii_hidden` is only present when greater than zero, so a person with the
role sees the same answers as before.

Counts leave PII out: a table's `column_count` and `measure_count`, and
`pii_hidden` itself, which counts over the dataset, the `removed` flag and
the `table` filter only, never over `name_prefix` or `unfiled`, so it cannot
be used to spell a hidden name. A metric whose every variant is on a PII
measure reads like a metric on datasets the caller cannot reach. A write
that names a hidden column, measure or variant answers `not_found` before it
writes, and a clash with a hidden variant is counted, never named.

Measure DAX (`get_variant`'s expression, drafts) can name a PII column but
never its values: inferring through measures is a non-goal.

**For a person with `pii_reader`.** Nothing is hidden, and the catalog
can tag what the rules cover: each column and measure item from
`list_columns` and `list_measures` carries `pii: true` when a rule covers
it, and each table item of `get_dataset` carries `pii: true` when a
`pii = true` table rule covers it. The key is absent otherwise, and absent
for a person without the role.

**Search.** `collectDocuments` emits no document for a PII column or
measure, so their names never go to the embedding provider, and leaves
out every element of an off dataset (`liveDatasets` filters on `enabled`).
A person with `pii_reader` finds PII columns through `list_columns`, not
search.

## Queries

In `executeDax` (`services/queries/execute.ts`), after `checkDax` and
before the row reservation, for a caller where `readsPii` is false:

1. `piiNamesOf(db, dataset.id)`. When any PII rule exists, call
   `ensureModelDetails` before `withRelatedEnds`, even if no mirrored table
   matches the rule. Read live table names and scan status together. A failed
   fold of those names refuses as `UNCHECKABLE`, with the deny row.
   If relationships remain null, unavailable or stale, deny and refuse when
   a rule covers a mirrored table, column or measure, the scan has
   `schema_error`, or there are no live tables. Otherwise, let the query run.
   The refusal says relationships are unknown; try later or ask an admin
   for `pii_reader`. Skip the read when names hide nothing.
   Scan relationships carry scan time and go stale with the schema.
   While `schema_error` is set, relationships are also due and not current
   when their read predates `synced_at`, which every dataset scan stamps.
   The five minute limiter still bounds retries.
   INFO reads use plain SELECTCOLUMNS names, returned in bracketed keys,
   and skip the caller query rate check and row reservation.
   Their logged rows still count toward the daily budget; reads have a
   five minute limit per person and dataset.
2. `lex(dax)` from `apps/api/src/dax/tokens.ts`, fold every table and
   column name with `foldNames`, then walk the tokens:
   - a `table` token followed by a `column` token is a qualified reference
     `t[c]`. It is refused when `c` is in the set `columns`,
     `ruleColumns`, `measures` or `ruleMeasures` holds for `t`, OR when `t`
     is in `ruleTables`, `c` is not in its cleared set, and `c` is not in
     the set `knownMeasures` holds for `t`. Either condition refuses; a
     cleared name never overrides `columns`. If the qualifier is not a
     table in this dataset's mirror, check `c` against `bare` too; refuse it
     when any table rule does not clear `c` unless `c` is a known measure;
   - a `column` token alone is `[c]`; refused when `c` is in `bare`;
   - a `table` token not followed by a `column` token is a whole table;
     refused when it is in `tables`;
   - a keyword token followed by a `column` token is a table too
     (`Order[Fresh]`), and the column is checked bare as well; a keyword
     where an operand is expected (after `EVALUATE`, `RETURN`, `IN`, an
     opening bracket, a comma or an operator) is a whole table
     (`EVALUATE Order`), checked against `tables`;
   - `MEASURE` or `COLUMN` followed by `t[x]` where `t` is in `ruleTables` is
     refused as `a definition on the table t`, since its body can name an
     unsynced column covered by the table rule. A derived foreign key in
     `tables` alone does not refuse a definition;
   - `COLUMNSTATISTICS`, `DETAILROWS`, `EXTERNALMEASURE` and `INFO.*`
     functions, table or column tokens used as functions, names ending in
     `.`, and non ASCII function names are refused on datasets with PII as
     possible spellings of model wide readers;
   - a qualified `t[c]` is also refused when `c` is the name of a PII
     measure anywhere in the dataset, even when the reference names another
     table (measure names are unique in a model; the mirror lists no non-PII
     columns, so a column of `t` with a PII measure's name is refused too).
   A column or measure rule's name is in `bare`, so `[c]` alone is
   refused even when the mirror lacks it. A bare reference to an unsynced
   column that only a table rule covers needs its table in scope, which
   takes a whole-table reference to a table in `tables`, which is refused.
   This covers `DEFINE` blocks too, because they are part of the text.
   Every name is folded by `foldNames`. A Postgres data error (SQLSTATE class
   22: a NUL, a bad encoding) refuses the query as `UNCHECKABLE`; any other
   error is rethrown, so an outage is an outage.
   Accepted gap: the `knownMeasures` exemption folds names, so an unsynced
   column on a covered table whose name folds to the name of a synced
   measure on that table passes as the measure.
3. On a refusal, write the `audit_event` deny row
   (`query.pii_refused`, detail: the dataset id and the references) and
   throw `ServiceError("refused", ...)`. The message names each reference
   and what to do, for example:
   `This query uses PII: Customer[Email], the table Customer. Use the
   table's other columns, or ask an admin for the pii_reader role.`
4. **Backstop, after Power BI answers.** Each result column key has the
   form `table[column]`. When one maps to a PII column, the result is not
   stored, the same deny row is written, and the same error is thrown.
   This catches a reference the token walk did not. A bare key `[name]` is
   refused when `name` is in `bare`.

`withRelatedEnds` (`services/pii/related.ts`) adds relationship ends to a copy
of the names to a fixed point. PII ends are columns in `columns` or
`ruleColumns`, or uncleared columns under `ruleTables`. The many side is
`from` for many to one or unknown cardinality, and `to` for one to many. A PII
many side makes the other table PII whole; a PII one side adds the many
side's key to `columns`. One to one and many to many make the other table
whole. A derived key does not make its own dimension PII whole.

`checkInput` refuses a lone CR, U+2028, U+2029, U+0085, a vertical tab and a
form feed in the DAX, as it refuses a NUL, so the lexer and the engine cannot
disagree on where a `//` or `--` comment ends.

`[name]` is matched against every PII column and measure name in the
dataset, as the client's system does. It can refuse a column of the same
name in another table; the message names it, so the agent can qualify the
reference.

Service accounts are always checked, since they never read PII.

Accepted gaps and tenant probes: only unrenamed result keys are backstopped;
Power BI errors are unchecked; probe whether `//` ends at lone CR, `--` is
always a comment, odd spellings and qualifiers are syntax errors,
`TABLEOF(t[c])` exists and returns the whole table, calculation group items or
user functions can reference PII (no rule kind covers them and the mirror does
not sync them), model-view result keys, and object-level security hiding
relationships. One reader's relationships are stored for the dataset and used
for other people's checks. Probe whether the scanner returns relationships.
Also probe INFO auto date, inactive and one-to-many relationships and
cardinality. On any tenant, a table added in Power BI since the last read of
the model (the scan, or the INFO views) whose foreign key carries a PII value
is not detected until the next read.

## Datasets on or off

```ts
listDatasets(context): Promise<Array<{
  id; name; workspace_id; workspace_name; enabled: boolean;
  tables: number; columns: number; measures: number; synced_at: string | null;
}>>;
setEnabled(context, dataset: string, enabled: boolean): Promise<{ id; name; enabled }>;
```

- In `apps/api/src/services/admin/datasets.ts`, requiring
  `admin:manage_datasets`. `dataset` is an id or an exact name; several
  datasets with the name is an `invalid` error asking for the id, as
  `executeDax` does.
- `setEnabled` is audited as `admin.dataset.on` or `admin.dataset.off` and
  queues a full embed run (`enqueueUnlessQueued`, job `embed`, no
  `changes_only`), so the dataset's documents leave or return.
- Variants on an off dataset disappear with it, because every book read
  filters on `describableDatasets`. A metric whose every variant is on
  an off dataset reads as it does today for someone who reaches none of
  its datasets.

## REST api

All under `/api/v1/admin`, in `apps/api/src/routes/v1/admin.ts`, described
in `openapi.json` (regenerated), and added to
`apps/api/src/routes/authorization-matrix.ts`:

| Method and path | Body or query | Answer |
|---|---|---|
| `GET /pii/rules` | `?pii=true\|false` | `{ rules: (PiiRule & { columns, datasets })[] }` with live matched column or measure and dataset counts |
| `PUT /pii/rules` | `{ kind, table, name?, pii, note? }` | `{ rule, columns, measures, datasets }` |
| `DELETE /pii/rules/:id` | | `204` |
| `GET /pii/suggestions` | `?dataset=` | `{ suggestions: [...] }` |
| `GET /datasets` | | `{ datasets: [...] }` |
| `PUT /datasets/:dataset` | `{ enabled }` | `{ id, name, enabled }` |

`set_via` comes from the principal (`principal.via`), never from the body.
Suggestions and rule counts include only datasets the caller can reach in
Power BI. Off datasets remain in reach for review before they are enabled.

## CLI

In `apps/cli/src/powerbi_metrics_book/commands/admin.py`, two new subgroups beside
`settings`, `secrets` and `roles`, each command taking `--json`:

```
pbmb admin pii list [--pii | --cleared]
pbmb admin pii mark   <ref> [--note TEXT]     # pii: true
pbmb admin pii clear  <ref> [--note TEXT]     # pii: false, reviewed
pbmb admin pii remove <ref>
pbmb admin pii suggest [--dataset NAME]
pbmb admin datasets list [--off]
pbmb admin datasets on  <dataset>
pbmb admin datasets off <dataset>
```

`<ref>` is `Customer[Email]` or `'Customer Dim'[Email]` for a column,
`Customer` for a whole table, and `--measure 'Customer'[Email Count]` for a
measure. `mark` prints how many columns and datasets the rule now covers.

## book.yml

`pbmb admin export` writes `pii_rules: [{ kind, table, name, pii, note }]`
(no `set_by`); `pbmb admin import` shows each added, changed or removed
rule as `pii_rules.<kind>:<table>[<name>]` in its preview and applies them
with the rest. Rules in the database and not in the file are listed under
`kept`, as service accounts are. Dataset on or off is not in `book.yml`:
it names datasets of one tenant.

## Docs and the main spec

- `apps/docs`: a page "PII" under make-it-yours (rules, the role, what is
  hidden and refused, the limits above) and a section on datasets on or off
  beside the workspace filter.
- `docs/specs/2026-10-25-powerbi-metrics-book.md`: the roles, the Cerbos
  table (`pii: read`, the two admin actions, `enabled` on `dataset`), the
  CLI list and the settings list.
- `docs/security/`: the PII page names its security tests.

## Testing

- **Security tests** (`*_security_test.ts`, the repo's convention), new:
  - `pii_security_test.ts`: for a `viewer` and a `viewer` with
    `pii_reader`, every surface in the table above, the three query
    refusals, the result backstop (a mock answer whose header is a PII
    column), and a service account holding `pii_reader` by policy still
    refused.
  - `dataset_switch_security_test.ts`: an off dataset is missing from every
    list, `get_dataset`, search, variants, and refused for queries, for an
    admin too; on again restores it.
- Unit tests next to each module: the precedence of column over table
  rules, case-insensitive matching, the token walk (qualified, bare, whole
  table, inside `DEFINE`, a name in a string literal not matched), the
  heuristic's matches and drops, the sync's insert-only `enabled`.
- Cerbos policy tests for `pii` and the admin actions.
- CLI pytest for each command and its `--json`.
- The api end-to-end test gains one scenario: mark `Customer[Customer]`
  (the customer's name; the sample tenant has no email column) as PII, then
  a viewer's query naming it is refused and a `pii_reader`'s passes.
- Tier 3 (`pnpm check:all`) before the PR.

## Tasks

Twelve sudocode issues in seven waves on `build/pii-and-datasets`. Issues
in one wave own disjoint files; the admin routes wait for the metadata
surfaces because both regenerate `openapi.json`.

| Wave | Issues |
| ---- | ------ |
| 1 | i-4fv0 data: `pii_rule`, `dataset.enabled`, the setting, the migration |
| 2 | i-2spa access: `pii_reader`, the `pii` resource, off datasets enforced |
| 3 | i-yeu3 the PII module; i-4geg the admin dataset list and switch |
| 4 | i-1yun metadata surfaces; i-39qi query refusal; i-3egz search; i-5nci book.yml |
| 5 | i-7imi admin routes |
| 6 | i-1xkz the CLI; i-3dgp the security tests |
| 7 | i-2ahj docs, the main spec and the api end-to-end scenario |

Every issue runs Sonnet. The access, PII module, query and security test
issues also get a security review.
