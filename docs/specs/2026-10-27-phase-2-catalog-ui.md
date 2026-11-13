# Phase 2: the catalog UI and the admin screens for PII and datasets

Taken 27 October 2026, spec together with Martin, from three rounds of a
throwaway prototype he reacted to. The phase after v1 (PR #1, merged), built
beside the PII and dataset switch build
(`docs/specs/2026-10-27-pii-and-dataset-switch.md`, on
`build/pii-and-datasets`). v1 kept the catalog out of the browser: agents and
the CLI browse the book. This phase puts the catalog in the browser for the
people who check what the agents work from, and gives admins the screens the
PII build's REST api was made for.

## Goal

- **The dataset diagram.** A dataset page whose first view is a diagram of
  its tables and relationships, readable on a real model of 16 tables and
  more, that says when relationships are unknown instead of drawing none.
- **The catalog.** Metrics filed in a tree of categories, each category with
  its description; a page per category, metric and term; the left tree to
  move between them; every variant and term column one click from its table
  in the diagram.
- **The admin screens.** A Datasets page to turn datasets on or off and to
  set whether new datasets start on, and a PII page to decide suggestions,
  add and remove rules. An admin can also mark a column as PII from the
  catalog, where they see it.
- **Shareable with Metrics Book.** Its spec plans the same catalog screens
  (`enum-studio/metrics-book`, `docs/specs/2026-10-25-open-data-stack.md`,
  section Screens, its Phase 8). Ours are built so the two can share them
  (below).

## Non-goals

- Editing the book in the browser beyond what exists: Approve on the metric
  page (v1) and marking PII. Writing descriptions, filing metrics and
  defining terms stay with agents and the CLI, through the curation API.
- Saving a person's diagram layout. Dragged tables stay put until the page
  changes; the layout is computed again on the next visit.
- Reports, lineage, values or query results in the catalog.
- Turning several datasets on or off in one action. The api takes one
  dataset per call; a large tenant sets new datasets to start off instead.
- Clearing a PII mark from the catalog. Removing protection is done on the
  PII page, where the rule and what it covers are shown.

## Settled by inspection (do not re-derive)

Martin chose these by looking at built screens, 27 October 2026. They have no
derivation an agent can reconstruct; a later change goes back to him.

1. **The layout.** Changed by Martin on 2026-11-05: the tree folds out of
   Catalog in the first lane (Metrics with its category tree, Terms, Datasets
   by workspace), search is a dialog, and the page lies flat beside the lane
   (`docs/decisions/look.md`). Dataset pages have tabs: Diagram, Tables, Measures,
   Relationships, each with its count.
2. **The diagram's tables show key columns by default**, the columns at
   either end of a relationship, with "N more columns, M measures" at the
   foot, and a switch to All columns. Each row has a key icon, an icon when
   Power BI hides the column, and the data type in mono.
3. **Facts on the left, the tables they look up to the right**, as dagre lays
   a many to one graph left to right. Lines are curves from column to column,
   with a crow's foot at the many end and a bar at the one end; an inactive
   relationship is dashed and labelled "inactive"; one that filters both
   ways is labelled "both ways".
4. **A large model reads like a page.** It fits the pane's width, never above
   100% and never below 60%, starts at the top, and the mouse wheel scrolls
   it; a pinch or Ctrl with the wheel zooms. When it is taller than the pane,
   a minimap shows in the bottom left.
5. **Lines answer the pointer.** Hovering a line turns it from grey to green;
   hovering a table turns its lines green; neither dims anything else.
   Clicking a table selects it: its lines and neighbours stay, the rest dims,
   and a panel on the right lists its description, columns, measures by
   display folder and relationships. Clicking a line opens the relationship
   in the same panel: the reference in DAX form, the cardinality, which table
   filters which, active or not (with `USERELATIONSHIP` named when not), and
   a button to each table. Clicking the empty canvas clears it. Tables can be
   dragged.
6. **Unknown relationships draw no lines.** The tables sit in a grid, a band
   above them says "No lines drawn." followed by the api's
   `relationships_note`, and the tab reads "Relationships unknown".
7. **The dataset header is compact:** the workspace on a small line, then
   the name in title size with the facts in mono beside it (storage mode,
   endorsement, row-level security, where the relationships came from, when
   it synced), then the description on one line.
8. **Metrics are filed in a tree of categories, each with its description.**
   Martin's correction in round 3. The left tree opens Metrics into
   categories, subcategories and the metrics in each, with each category's
   count including its subcategories, open along the way to the current
   page. The catalog's home is the categories in order, each with its
   description and its metrics, subcategories indented under their parent.
   Each category has a page: a breadcrumb, its description, its
   subcategories with theirs and their counts, and the metrics filed in it.
9. **The metric page is the v1 review page, in the catalog.** The text in the
   main column (definition, when to use it, not the same as), the variants
   with their measure, dataset, shift and DAX, the open questions; beside it
   Approve (for a curator, as in v1), unit, category as a breadcrumb, owner,
   other names, terms. Each variant has "Copy DAX" and "Show <table> in the
   diagram", which opens the dataset with that table selected and in the
   middle of the view.
10. **The term page** puts its words first (kind, trust, definition, not the
    same as, other names, values), then the columns that hold the term, each
    with "Show in the diagram", then the metrics that use it.
11. **Trust in words, everywhere:** "Approved by a person" with a tick in the
    accent, "Checked by an agent", "Draft" in the faint ink. No dots.
12. **Admin Datasets:** the setting "A dataset the sync finds for the first
    time starts On / Off" first, then every dataset grouped by workspace with
    its counts, when it synced, and a switch per row with "On" or "Off"
    beside it. A switch acts at once and a message says what happened, with
    Undo; there is no confirm dialog.
13. **Admin PII:** a lede saying what PII rules do, how many people hold
    `pii_reader` with a link to People and roles, then Suggestions (column,
    matched word, datasets, "Not PII" and "Mark PII"), then Rules (filter
    All, PII, Not PII; "Add a rule"), each rule with its reference, PII or
    Not PII, what it covers, who set it and how, when, and Remove with Undo.
14. **PII in the catalog:** in the table panel a column covered by a rule
    carries a "PII" tag, and an admin sees "Mark PII" on a column when
    hovering or focusing its row.

## Decisions taken in the build of the prototype

Reasoned, not looked at; open to a better argument.

- **Routes.** `/catalog` (the home), `/catalog/categories/$` (the category's
  path, `sales/orders`), `/catalog/metrics/$name`, `/catalog/terms`,
  `/catalog/terms/$term`, `/catalog/datasets/$id` with `?tab=` and
  `?table=` (a table to select on arrival), `/admin/datasets`, `/admin/pii`.
  A signed-in person's `/` goes to `/catalog`, not to their connections.
- **One metric page.** `/review/metrics/$name` keeps working (agents have
  sent the link) and sends the browser to `/catalog/metrics/$name`; the api's
  review link (`services/book/metrics.ts`) names the catalog path from now on.
- **Section labels in sentence case** ("Definition"), not the review page's
  uppercase mono labels: six of those on one page read as decoration. The
  review page's labels change with it.
- **The metric list** shows each metric's label and one-line summary, unit,
  how many datasets hold a variant, and its trust. Dismissed metrics are left
  out; metrics in no category are listed last, under "Not filed".
- **Category counts** are the metric's own category plus every category
  below it, summed in the SPA from `GET /api/v1/categories`, whose
  `metric_count` counts a category's own metrics only.
- **A phone** (under 768px) gets the Relationships tab as the dataset's first
  tab: a diagram cannot be read at 390px. The tree folds into a menu button
  above the page, as the admin nav folds into a select.
- **Keyboard.** Tables in the diagram take focus in reading order; Enter
  selects, Escape clears. Every relationship is reachable without a pointer
  through the table panel's relationship list.
- **Search** is the tree's box: `/` focuses it, typing asks
  `GET /api/v1/search` and lists metrics, terms and datasets that match,
  grouped by kind; Enter opens the first. Not prototyped: judged at the
  attended gate.
- **Marking PII from the catalog** is one click with Undo in the message,
  like the switches. A PII tag links to the rule on the PII page; it does not
  clear the mark (Non-goals).
- **A person without `pii_reader`** sees "N columns hidden as PII" in the
  table panel when the columns answer reports `pii_hidden`, and nothing else
  of them.

## The screens and their references

Each screen starts from its Mobbin references (Martin's design rules), in the
look of `packages/tokens`, light and dark, 390px to 1440px. Structure and
decisions are taken from them; nothing is copied.

| Screen | References and what each gave |
|---|---|
| Dataset page and diagram | Supabase's schema visualizer (tables with a key and a type per column, the legend under the toolbar): https://mobbin.com/screens/7cba75b0-973e-469d-a078-3d2794491701 ; Databricks' catalog explorer (the tree beside a dataset page with tabs): https://mobbin.com/screens/91c5835b-e26a-4936-9525-89e882f29789 ; Customer.io's data index (one item's details in a side sheet, its Sensitive flag): https://mobbin.com/screens/dbfa6ace-caa4-41ba-a341-03e984351303 ; an earlier prototype's relationships graph (React Flow with a dagre layout, key columns only) |
| Metrics home and category page | Steep's metrics catalog (name and one-line description per row, grouped by category): https://mobbin.com/screens/4aab856e-b4c1-45c3-bc06-1ed83475ea94 ; an earlier prototype's category page (description, subcategories, metrics) |
| Metric page | Steep's metric editor (text in the main column, properties beside it, the formula as code): https://mobbin.com/screens/ed6167e7-2436-4184-8476-6d3e97599631 |
| Term page | Vanta's policy page (the text first, then a table of what it is tied to): https://mobbin.com/screens/175c17d5-7fb4-443f-a3df-6f889c6fac18 |
| Admin Datasets | Supabase's database extensions (a table with a switch per row): https://mobbin.com/screens/fc0c7686-b8c7-4194-b07b-c4aa86bd64ef ; Clay's enrichments (the switch's state in words beside it): https://mobbin.com/screens/fba46ffc-5aa8-4afb-991c-64978da2093e |
| Admin PII | Customer.io's data index (a field marked Sensitive); the admin section's own page frame and sections from v1 |

The prototype the decisions came from is not in the repository. Its
screenshots were shown to Martin on 27 October; `check:ui` replaces them as
the place to judge the look.

## What each screen asks of the api

Everything is read from `/api/v1` through TanStack Query, typed from
`openapi.json`, as `apps/web/AGENTS.md` requires.

| Screen | Endpoints |
|---|---|
| Tree | `GET /categories`, `GET /metrics` (`category`), `GET /terms`, `GET /datasets`, `GET /workspaces` |
| Category page | `GET /categories/{path}`, `GET /metrics?category=` |
| Metric page | `GET /metrics/{name}`, `GET /metrics/{name}/variants`, the v1 review page's others |
| Term page | `GET /terms/{name}` |
| Dataset page | `GET /datasets/{id}` (tables, relationships, `relationships_source`, `relationships_note`), `GET /datasets/{id}/columns`, `GET /datasets/{id}/measures` |
| Search | `GET /search` |
| Admin Datasets | `GET /admin/datasets`, `PUT /admin/datasets/{dataset}`, `GET` and `PUT /admin/settings/powerbi.datasets.new` |
| Admin PII | `GET /admin/pii/rules`, `PUT /admin/pii/rules`, `DELETE /admin/pii/rules/{id}`, `GET /admin/pii/suggestions`, `GET /admin/people` (who holds `pii_reader`, and the email of who set a rule) |

Three shapes from the PII build that these screens read:

1. For a caller who reads PII, each column and measure in `list_columns`,
   `list_measures` and `get_dataset`'s tables carries `pii: true` when a rule
   covers it, and no `pii` key otherwise (PII build issue i-1yun).
2. For a caller without `pii_reader`, a list answer carries
   `pii_hidden: <count>` when it left something out (i-1yun).
3. `GET /admin/pii/rules` returns `columns` and `datasets` per rule, and
   `PUT` answers the same counts (i-7imi). They count only the datasets the
   calling admin can reach in Power BI, so an admin with little reach can see
   0 for a rule that protects PII elsewhere. The PII page says "Covers N
   columns in M datasets you can reach", so nobody removes a rule as dead.
4. `GET /admin/pii/suggestions` is limited to the same reach, and its
   `?dataset=` answers 404 outside it. `GET /admin/datasets` lists every
   dataset regardless of reach.

## Built to be shared with Metrics Book

- The catalog lives in `apps/web/src/catalog/`, one folder per area
  (`tree/`, `categories/`, `metrics/`, `terms/`, `datasets/`, `search/`).
- The diagram is `apps/web/src/catalog/diagram/`, a component that takes a
  neutral model and imports nothing from `src/api`:

  ```ts
  export type DiagramTable = {
    name: string;
    description: string | null;
    columns: { name: string; type: string | null; hidden: boolean; pii?: boolean }[];
    measures: { name: string; folder: string | null }[];
  };
  export type DiagramRelationship = {
    from_table: string; from_column: string; to_table: string; to_column: string;
    cardinality: string | null; // "Many:One", as Power BI names it
    filters: "one_way" | "both_ways";
    is_active: boolean;
  };
  export type DiagramModel = {
    tables: DiagramTable[];
    relationships: DiagramRelationship[];
    /** Set when relationships are unknown: the sentence to show, no lines drawn. */
    unknown: string | null;
  };
  ```

  The dataset page maps the api's answer to it. Metrics Book's datasets map
  to the same model, so the component moves to a package beside
  `@enum-studio/tokens` the day Metrics Book builds its Phase 8, as the
  tokens did.
- Route names match Metrics Book's plan (`/catalog`,
  `/catalog/metrics/...`, `/catalog/datasets/...`, `/catalog/terms/...`).
  Metrics Book addresses a metric under its dataset; ours by name, since a
  metric here spans datasets. The sharing decision is recorded in
  `docs/decisions/look.md`.

## Dependencies

`@xyflow/react` 12.10.2 and `@dagrejs/dagre` 1.1.5 in `apps/web`, pinned
exactly (AGENTS.md rule 4). Both are MIT, run in the browser only and fetch
nothing. React Flow's stylesheet is imported once in `apps/web/src/styles.css`
and its colours set from the tokens, so the diagram follows dark mode.

## Security

- **New SPA paths are public shells,** as every SPA path is: the HTML and
  assets only, with every datum behind `/api/v1` and its own check. Each path
  joins `SPA_PATHS`, `public-paths.ts` and the authorization matrix, with a
  line in their security tests (AGENTS.md rule 1).
- **The CSP stays `default-src 'self'`.** React sets styles through the DOM,
  which the policy allows; nothing may inject a `<style>` element or a
  `style` attribute in markup. The e2e fails on any CSP violation in the
  console.
- **Marking PII from the browser** goes through `PUT /admin/pii/rules`,
  checked by `admin:manage_pii`, and records `set_via: browser` from the
  principal, never from the body.
- **No new boundary.** The SPA decides no permission: a Mark PII control and
  the admin pages show for an admin, and the api refuses anyone else.
- The issues that touch `public-paths.ts`, the authorization matrix or the
  admin PII and datasets screens get a `security-reviewer` pass.

## Testing

- **Unit tests** beside the diagram: rows per density, layout determinism
  for the same model, the viewport (fit to width, 60% and 100% bounds, top
  aligned when taller, the arrival table in the middle), the line ends from
  `cardinality`, the unknown state's grid. Beside the tree: category counts
  summed over subcategories, the path opened for a metric two levels down.
- **Playwright** on the dev stack with the mock tenant, one spec per area:
  `catalog-metrics.spec.ts`, `catalog-datasets.spec.ts`,
  `catalog-terms.spec.ts`, `catalog-search.spec.ts`, `admin-datasets.spec.ts`,
  `admin-pii.spec.ts`, `catalog-pii.spec.ts`. Each checks its flows,
  including: hovering a line changes its stroke to the accent; clicking a
  line opens the relationship; "Show Order lines in the diagram" arrives with
  the table selected and in view; Marketing shows "No lines drawn."; a
  switch turned off removes the dataset from the catalog tree and Undo
  brings it back; a viewer without `pii_reader` sees the hidden count and no
  PII column; no CSP violation on any page.
- **`check:ui`** picks up every new route from the router, in both themes at
  390 and 1440px, with sample values for `$id`, `$name`, `$term` and the
  category path.
- **Sample content on the dev stack.** `pnpm dev:up` seeds a sample book
  through the curation API (categories with descriptions, metrics filed in
  them, three terms), and the mock tenant gains a larger invented model,
  "Retail" (16 tables, 20 relationships), so the large-model
  layout is checked on every run.
- Tier 3 (`pnpm check:all`) before the pull request.

## Tasks

Twelve sudocode issues in six waves on `build/phase-2-catalog`, cut from
this spec's branch. Issues in one wave own disjoint files. Waves 4 to 6 wait for
`build/pii-and-datasets` to merge into `main`, and the branch merges `main`
in before wave 4. Every issue runs Sonnet; the UI issues carry the settled
decisions above and their references, and the attended gate is where
Martin's eye comes in.

| Wave | Issues |
|---|---|
| 1 | the diagram component; the sample book on the dev stack; the Retail sample model |
| 2 | the catalog frame: routes, SPA paths, header, tree, home and category pages |
| 3 | the dataset page; the metric page; the term pages; catalog search |
| 4 | the admin Datasets page |
| 5 | the admin PII page; PII in the catalog |
| 6 | docs, decisions and the main spec |

Each issue's files, depends, verify and budget are in `.sudocode/issues.jsonl`.
