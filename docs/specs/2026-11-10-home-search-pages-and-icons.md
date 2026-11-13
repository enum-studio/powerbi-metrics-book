# Home is search, field pages, and icons

Home becomes the search page: a large search box, and the results open in
place under it as they do in the reference catalog, an earlier metrics
catalog Martin built. The setup checklist stops
taking over Home and shrinks to a small notice that goes away when the
steps are done. Search finds a name from its first letters and through a
typo, and it puts verified metrics first. Each display folder and each
column gets a page of its own under its dataset. Metrics, categories, terms,
datasets and workspaces can carry an icon, chosen in the app or set by an
agent through `pbmb`.

Status: draft for Martin's review, 2026-11-10. Mode: spec fast. Sensitive
paths: search visibility, new read routes, a new curation route, a
migration. Every API task ends in a security review.

## What Martin asked, and what is assumed

Asked, 2026-11-10:

- Home and Search are one page, with every search feature on it. Results
  show in place under the box, as in the reference catalog (answered: "Results in
  place").
- The finish setup notice has to say done when the steps are done. It
  becomes a smaller notice on Home. The stuck row is "Structure your
  drafts" (answered).
- Search is as good as the reference catalog's and Secoda's. The model is
  the reference catalog's results page.
- Display folders and columns get pages under datasets, after the
  reference catalog and Secoda.
- Icons, as Secoda has them, on metrics, categories, terms, datasets and
  workspaces (answered), settable by agents through the CLI.

Assumed, for Martin to correct:

- An icon is how a thing looks, not what it means. Setting one through a
  token leaves a metric's trust state alone, and it is still recorded in
  `book_change`.
- Power BI tables, columns and measures keep fixed icons by their type,
  as in Secoda. Only the five kinds above take a chosen icon.
- Results show no numeric score. The reference catalog shows one, but an RRF score
  means nothing to a reader.
- The tree's column rows go to the new column page rather than the
  diagram. The diagram stays one click away on the dataset page.

## Non-goals

- Recent searches or recently viewed items. They would need per-person
  storage in the API, which is a separate change.
- Sample values on a column page. They need a query that runs with the
  person's own Power BI rights and is logged. That is a later button.
- Display folders as a search kind. A folder is found through its
  measures, and its page is linked from every measure's path.
- An AI answer mode in the Home box (Secoda's "AI" toggle). The agent
  answers through the connector, and the product has no AI of its own.
- Icons on tables, columns or measures.

## 1. Why "Structure your drafts" never closes

`apps/web/src/home/home.tsx:161` marks the row done only when `draft` is
0. The sync drafts every measure it finds, so a real book always has
drafts. Prod has 1,167 drafts and 130 agent-verified metrics today (from
`whoami`, 2026-11-10). The check counts the wrong thing; nothing is broken
in how it is calculated.

**Decision: the step is "Start structuring your drafts", and it is done
once one metric is verified (agent or human).** Setup asks whether
curation has started; whether it is finished is ongoing work, and the
count of drafts moves to Home's stats line, where it links to the drafts
guide. The other done conditions stay as they are: Power BI connected,
one grant (MCP or CLI), a grant used (fixed in `f8ab9d2e`), and more than
one person for an admin.

## 2. Home is the search page

`/` shows the search. `/?q=gmv&kind=metric` shows results.
`/catalog/search` redirects to `/` with the same query, because links to
it are out in docs and bookmarks.

With nothing typed:

- The search box sits at the top of the page, full width of the reading
  column, 48px tall, autofocused on a pointer device. Placeholder: "Search
  metrics, terms, datasets, tables and columns".
- Under it is one stats line: "1,297 metrics in 37 datasets: 130 verified,
  1,167 drafts". "drafts" links to the drafts guide for a curator and is
  plain text for anyone else (the Metrics list has no drafts filter yet).
- Under that are four example searches as rows you can click. They are
  fixed sentences, never a name from Power BI, as on Home today ("which
  metric is revenue", "orders by month", "net sales in EUR", "what does
  churn mean").

With text typed (2 or more characters, 200 ms debounce, `replace`
navigation as today):

- The box shows the result count at its right end, as the reference
  catalog does.
- **The filter bar** has a Type control (All, Metrics, Measures, Terms,
  Categories, Datasets, Tables, Columns) and an "Add filter" menu with
  Trust (Draft, Agent verified, Human verified), Workspace, Dataset and
  Category. Each of these is a filter `GET /api/v1/search` already takes.
  Each filter is a removable chip and lives in the URL.
- **Best match** is a card shown when the first hit matched as `exact` or
  `words`. A first hit found by meaning alone gets no card, the same rule
  the reference catalog applies with its 0.5 floor. The card shows the icon, the
  name, a kind badge, the trust badge, two lines of summary with the typed
  words marked, and the path as links.
- **Sections** follow, one per kind and in a fixed order: Metrics,
  Measures, Terms, Categories, Datasets, Tables, Columns. Each header shows
  the count, e.g. "Metrics (13)", and a "Browse all" link to that kind's
  list, which exists for metrics and terms (datasets have no list page;
  the tree is that list).
  - Five rows show in each section, then "Show all 13", which asks the API
    for that kind alone with limit 50.
  - Metrics, Measures and Terms are open at first. The rest start folded
    unless they are the only section.
- **A row** has the icon, the name, a line under it with the path
  (Workspace / Dataset / Table / Folder for a measure or column, the
  category path for a metric), one line of summary with the words marked,
  and the trust badge on the right.
- **Keys:** ArrowDown leaves the box for the first row, the arrows then
  move through every visible row, Enter opens a row, and Esc goes back to
  the box. `/` and Cmd+K focus the box on Home.
- **Empty and error states:** the existing `EmptyState` and `ErrorState`.
  When `search_mode` is `words_only`, the API's note shows above the
  results.

Every kind opens a page:

| Kind | Page |
|---|---|
| metric | `/catalog/metrics/$name` |
| variant (Measures) | its metric's page, with that variant marked (`?variant=<id>`) |
| term | `/catalog/terms/$term` |
| category | `/catalog/categories/$` |
| dataset | `/catalog/datasets/$id` |
| table | the table page (section 4) |
| column | the column page (section 4) |

Hits of a kind the SPA had no page for were dropped before (`hitPage`
returns undefined). Now none are.

**The finish setup notice** is a button at the right of the page header,
where Secoda keeps "Customize": "Finish setup 3 of 5". It opens a popover
with today's checklist rows. The rows are unchanged apart from section 1,
and the "When you want more" links move into the popover's foot. The
button shows only while a step is open. With every step done, nothing
shows. For an admin, failing checks show as one line under the stats line,
"2 things to look at", linking to Status, because they are not setup.

**The first lane:** the Search row goes, and Home is the first row. The
search icon comes back to the lane's header, as in Secoda, and opens the
search dialog from any page. `/` and Cmd+K open the dialog anywhere but
Home. The dialog keeps its job (type, see the top hits, Enter on the first
row for all results). It now draws its rows with the same component as the
page, and its first row goes to `/?q=`. This replaces part of "Metrics,
Terms and Datasets at the root" in `docs/decisions/look.md`, which gets a
new section.

## 3. Search ranking

All changes are in `apps/api/src/services/search/query.ts`. Visibility,
rate limits and the statement timeout are untouched.
`search_visibility_security_test.ts` must pass unchanged.

1. **Prefix:** the words side also matches the last typed word as a
   prefix. `gm` finds `gmv`, `net sal` finds `net sales`. Build the
   tsquery from the words already typed, ANDed, with `:*` on the last one,
   on the `simple` configuration. A last word under 2 characters gets no
   prefix.
2. **Typos:** a third ranked list joins the RRF. It holds the documents
   whose `lower(label)` or `lower(name)` have trigram `similarity` of 0.3
   or more with the lowered query, ordered by similarity, capped at the
   pool. A migration adds `gin_trgm_ops` indexes on `search_document.name`
   and `search_document.label`. `pg_trgm` is already installed
   (`stack/postgres/init/01_roles_and_database.sh:49`). A hit found only
   this way has `match: "words"`.
3. **Trust:** after the fusion, a hit gets `+0.0015` when agent verified
   and `+0.0025` when human verified. With RRF_K 60 that lifts a verified
   hit about 6 ranks, and a human verified one about 10. An exact hit's
   `+1` stays above every boost. Tests pin both: an agent verified metric
   at words rank 3 outranks a draft at rank 1, and a draft exact hit
   outranks a human verified words hit.
4. **Counts:** the answer gains `counts`, a map from kind to how many
   hits of that kind the caller may see: every exact, words and trigram
   match, before any list is cut to its pool, and the meaning pool. The
   words and trigram lists keep their pool of every kind; one shared pool
   let columns crowd metrics out (found walking the sample, "sales":
   "Metrics (5)" where 9 match). A count cut at the pool showed
   "Measures (100)" for "gmv" on production after release. The
   sections show it, and a section offers "Show all" whenever it holds
   fewer hits than its count.
4a. **Exact hits by kind:** among exact hits the sections' order comes
   before the fused score, so "net sales" leads with the metric, not a
   measure of the same name that the words list happened to rank higher.
5. **Paths:** each hit gains `path: { kind, id, name }[]` from the root
   down, with only what the caller may see, under the same rule as
   today's `dataset` field. Workspace, dataset, table and display folder
   for a variant, column or table. The category path for a metric. Empty
   for a term, a dataset's workspace only. A metric in several datasets
   gets its category path only.
6. **Icons:** each hit gains `icon: string | null` (section 5).

## 4. Display folder, table and column pages

**The mirror keeps columns' display folders.** `powerbi_column` gains
`display_folder text`, and the api may update it, as it may on
`powerbi_measure`. The info-views read in
`apps/api/src/services/mirror/info-views.ts` reads
`INFO.VIEW.COLUMNS()` `[Table]`, `[Name]` and `[DisplayFolder]` alongside
the measures, with the caller's own token, and sets them the way
`setDisplayFolders` does for measures. The mock answers the same view, and
the sample tenant gives some columns a folder. The tree then folds columns
by folder as it folds measures (`docs/decisions/look.md`, "Datasets fold
down to the field", stops being right when the mirror keeps columns'
display folders, which this does).

**Routes in the SPA:**

- `/catalog/datasets/$id/tables/$table`: the table page.
- `/catalog/datasets/$id/tables/$table/folders/$folder`: a display folder
  page. The folder is one encoded segment holding Power BI's own folder
  path, with `\` between levels (`Dates%5CFiscal` in the address bar). It is
  not a splat: a splat keeps `/` and dot segments, so a folder name could
  move the link. No link is built for a folder level, table or column named
  exactly `.` or `..`.
- `/catalog/datasets/$id/tables/$table/columns/$column`: a column page.

`$table` and `$column` are names, URL-encoded, unique within their parent.

**The table page and the folder page are one component.** The table page
is the folder page at the root. It shows:

- the breadcrumb: Datasets / Workspace / Dataset / Table / each folder
  level;
- the title with the folder or table icon, and the table's description
  for a table page;
- a list you can filter, as Secoda's table page: subfolders first, then
  measures, then columns.
  - Columns of the list: Name, Kind (Folder, Measure, Column), Type (the
    format string or data type), Metric (the metric a measure belongs to,
    with its trust badge) and Description.
  - Each row links to its page: a folder to its folder page, a measure to
    its metric with the variant marked, a column to its column page.
  - A measure in several folders (`;`) appears in each, as in the tree.

**The column page shows:**

- the breadcrumb down to the column's folder;
- the title with the data type icon (`columnIcon`), and badges for
  Hidden, Calculated and PII (the mirror keeps no key flag);
- the description, editable by a curator through the existing docs route;
- properties: data type, format string, display folder, column type, and
  the DAX expression for a calculated column;
- **Terms**: the terms backed by this column (`term_column`);
- **Relationships**: those whose from or to is this column, each linking
  to the dataset's relationships tab;
- **Used by**: the measures in this dataset whose expression names the
  column, as `'Table'[Column]` or `Table[Column]`, or as `[Column]` inside
  a measure of the same table. This is found by text, so the section says
  "Measures whose DAX names this column".

**API:** one new route, `GET /api/v1/datasets/:id/columns/:column_id`,
answers the column page with
`{ column, table, terms, relationships, used_by }`. It goes through the
same service layer and Cerbos check as `GET /datasets/:id/columns`, has an
authorization test beside it, and is refused for a dataset the caller may
not see as if it did not exist. The PII rule that hides a column's
description and name from someone without PII rights applies here as on
the list. The folder and table pages use the existing
`/datasets/:id/measures?table=` and `/datasets/:id/columns?table=`, which
gain `display_folder` on columns.

**The tree:** a folder row links to its folder page, a table row to its
table page, and a column row to its column page. Measure rows keep going
to the metric. The current page's row is marked as today.

## 5. Icons

**What an icon is:** a text value in one of two forms, held in a nullable
`icon` column on `metric`, `category`, `term`, `powerbi_workspace` and
`powerbi_dataset`.

- `emoji:<one emoji>`, e.g. `emoji:📈` or a flag, `emoji:🇩🇰`. The service
  checks it is one grapheme (`Intl.Segmenter`) matching `^\p{RGI_Emoji}$`
  (the `v` flag) with no ASCII character, 32 bytes at most. RGI takes
  flags, which suit a country's dataset, and refuses an emoji with hidden
  tag characters after it. No ASCII rules out keycaps, which the database
  refuses too. An emoji written with a variation selector it does not need
  ("💰" as U+1F4B0 U+FE0F, as emojibase and many keyboards write it) is
  taken and stored without the selector; one that needs its selector keeps
  it. The picker offers each emoji in that form.
- `glyph:<name>:<color>`, e.g. `glyph:chart-line:green`.
  - `<name>` comes from `ICON_GLYPHS`, a list of about 120 Lucide icon
    names suited to a business catalog: charts, money, people, shop,
    time, places, data, documents and shapes.
  - `<color>` is one of `gray`, `green`, `teal`, `blue`, `violet`, `red`,
    `amber`, `ink`.

**The database decides validity** (rule 3). A CHECK on each column holds
the shape:

```
icon ~ '^(emoji:[^\u0001-\u007f\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069]{1,8}|glyph:[a-z0-9-]{1,40}:(gray|green|teal|blue|violet|red|amber|ink))$'
  and octet_length(icon) <= 38
```

The emoji half refuses ASCII and the bidi and zero-width controls, but
keeps U+200D, the joiner inside a family emoji.

A second CHECK holds the glyph name to `ICON_GLYPHS`. The migration writes
it from the same constant, so a new glyph is a migration.
`powerbi_workspace` and `powerbi_dataset` add `icon` to `apiUpdates(...)`.
The sync never writes the column, so it never moves a curator's icon
(rule 9).

**The colors** are eight new tokens in `@enum-studio/tokens`,
`--icon-<color>`, in light and dark. `contrast.test.ts` holds each at 3:1
or more against `--surface`, the bar for graphics.

**Writing an icon:**

- `PUT /api/v1/elements/:kind/:id/icon` with `{ "icon": "emoji:📈" }`.
- `DELETE /api/v1/elements/:kind/:id/icon` clears it.
- `:kind` is one of `metric`, `category`, `term`, `workspace`, `dataset`.
  `:id` is the element's uuid, as on `PUT /elements/:kind/:id/docs`. The
  CLI resolves a name or a category's key path to the id with the existing
  reads before it writes.
- Cerbos allows a curator or an admin, from a browser session or a token.
  A viewer is refused.
- Each change writes one `book_change` row with action `icon`, the before
  and the after. A metric's trust state does not change.
- The connector has no icon tool (rule 7).

**Reading an icon:** every read shape of those five kinds gains
`icon: string | null`. That covers the metric, the metrics list, the
categories tree, the term, the terms list, the dataset, the datasets list,
the workspaces, search hits and paths, and `pbmb ... show --json`.

**The CLI**, one module `apps/cli/src/powerbi_metrics_book/commands/icons.py`:

```
pbmb icons set metric net_sales 📈
pbmb icons set category sales/retail chart-line:green
pbmb icons set dataset "Retail Sales" store        # a glyph with no color takes gray
pbmb icons clear term "Active customer"
pbmb icons list [--search chart]                   # the glyph names and the colors
```

The CLI turns a bare emoji into `emoji:...` and `name[:color]` into
`glyph:name:color`. The API's refusal, the same words as the CHECK's
meaning, is shown as is. The curation skill in `skills/` gains one line:
an agent may give a category or metric an icon when it files it, and only
from `pbmb icons list`.

**The app:**

- `IconPicker`, as Secoda's: an Emoji tab with search and the Unicode
  groups, an Icons tab with the eight colors over a searchable grid of
  `ICON_GLYPHS`, and Reset. The emoji list is a pinned dependency (e.g.
  `emojibase-data`, compact English), filtered by the service's own rule
  and without the components group, so the picker never offers an emoji
  the api refuses. The glyphs are `lucide-react`, already a dependency,
  imported by name into a map keyed by the `IconGlyph` union, which the
  api's schema carries (`ICON_GLYPHS` is `as const`, `GET /icons` uses
  `z.enum`). No `import *`: it puts all of Lucide in the bundle.
- A curator sees the icon above the title on a metric, category, term,
  dataset or workspace page, and clicking it opens the picker. Anyone else
  sees the icon and nothing to click.
- `ItemIcon` draws an icon everywhere a row of those kinds appears: the
  tree, search rows and the Best match card, breadcrumbs, lists. With no
  icon it draws today's kind icon.

## Documents that change

- `docs/decisions/look.md`: the lane loses the Search row and gets the
  header icon back. A new "Home is search" section.
- `docs/decisions/search.md`: prefix, trigram and trust boost, with their
  numbers and when they stop being right.
- `docs/decisions/book.md`: icons are presentation and leave trust alone.
- `docs/security/threat_model.md`: the new column route and the icon
  route, if a boundary moves.
- The docs site: the CLI reference for `pbmb icons`, and the Home and
  search pages of the user guide.

## How it is tested

- **Tier 1 beside each change.**
  - Home: the setup button shows "N of M" and disappears at all done. The
    drafts step is done at one verified metric.
  - Search page: sections, Best match rule, Show all, keys, URL filters.
  - Search query: prefix, typo, the two trust-boost cases, counts and
    paths for a caller who sees part of a metric's datasets.
  - Icons: the CHECK refuses a bad value in SQL, not only in the service.
  - The icon route: viewer refused, curator allowed, `book_change`
    written, trust unchanged.
  - The column route: an outsider gets 404.
  - Mirror: column folders read and kept.
  - The CLI: `icons set` turns each form into the wire value.
- **Security tests:**
  - `search_visibility_security_test.ts` extended so a path never names a
    dataset or workspace the caller cannot see.
  - A new `column_detail_security_test.ts` for the route.
  - An icon case in the curation authorization tests.
- **Tier 3 before the pull request:** `pnpm check:all`, with the e2e Home
  and search flow on the mock at 390 and 1440 px, in light and dark.
