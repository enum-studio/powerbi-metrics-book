# The look

Taken in the spec of 2026-10-25, during the build (2026-10-25 to 2026-10-27) or in the phase 2 spec
(2026-10-27), as each says.

## One token package for both products

**Both products take their look from one package of design tokens, `@enum-studio/tokens`, pinned at
a version; each product sets only its name beside the mark.** Taken 2026-10-25 from the brief. The
tokens implement the Enum Studio brand (one mark, Inter and IBM Plex Mono, bottle green `#1f4a3a`),
start from the planner's `tokens.css`, and add the dark values both specs need (green `#8fc1a6` on
`#0b0d0f`). `contrast.test.ts` holds every text pair at 4.5:1 or more, in both themes. A change to
the look is one pull request to the package and one version bump in each product. Stops being right
if the two products' designs diverge on purpose.

## Where the tokens live

**The package is `packages/tokens` in this repository, already in its final shape, until
`enum-studio/tokens` exists.** Taken 2026-10-25 (review item 1). The recommendation was a small
repository of their own, published as `@enum-studio/tokens`, so neither product owns the other's
look; the alternatives were to publish from here or to put it in Metrics Book. Moving it is a move
and a publish. Stops being right the day Metrics Book needs the tokens and cannot depend on this
repository; that is the day to make the repository.

## The Tailwind mapping uses `@theme inline reference`

**`theme.css` maps tokens to Tailwind utilities with `@theme inline reference`, so no
self-referencing variables are emitted.** A plain `@theme` that names `--color-ink: var(--color-ink)`
emits a variable that refers to itself and resolves to nothing. Stops being right when Tailwind
changes how `@theme` handles `var()`.

## What the shell shows, and how time reads

**An admin sees Status and Settings in the first lane. Every time shown is the viewer's local time with its
zone, through one shared formatter (cron lines may keep UTC). One copy-button component serves every
value to copy.** Decided in the visual review of `build/v1` (390 px light, 1440 px dark). The `check:ui`
screenshots, in both themes, are the place to judge the look. Stops being right if a screen must
show a time in another zone.

## Two left lanes, with Catalog folding out

**The signed-in app has a first lane that always stays: the name and search, Home, Connections,
Catalog, and for an admin Status and Settings. Catalog folds out in place: its arrow folds the tree,
its name opens the catalog. Settings opens a second left lane with its pages in labelled sections,
wherever the first lane is shown, so from 1024px. Below 1024px the first lane is a drawer, and
Settings' pages fold out under Settings in it.** Taken
2026-11-05 by Martin, replacing the top bar and the rail inside the admin section. He first saw one
column whose admin pages opened below the places, and rejected it: a settings page is somewhere you
click to, not something to fold. He then named Secoda as the thing to copy, and we walked it, taking
only what this product has (it also has an inbox, an assistant and teams, which have no place here).
Status and Settings are pinned below the tree rather than below it in the scroll, as Secoda has
them: a tree opened on a large book runs to hundreds of rows, and Settings must stay one click away.
Under 560px tall, a landscape phone, or with Settings' pages open in the drawer, the whole lane
scrolls instead, because pinned rows would leave the tree about 30px. The tree lists a category's metrics a page at a time, and while a metric's own
row is not showing, the nearest row on the way to it is marked.
The first version put the pages in a strip above the page below 1280px, to give wide tables room.
Martin rejected it the same day: a sub menu under Settings is a left lane, not a top menu. So at
1024px the two lanes leave the page 536px. The admin section lays out by the width of its own frame,
not the window's, and a table wider than that scrolls inside its box. In the drawer Settings folds as
a whole row, as Datasets does, because it has no page of its own.

A hovered row takes `--raised`. The page's own row takes `--accent-soft`, the selected row's wash, and
`--accent` for its text. Both washes were `--raised` at first, so a hovered row read as a second
current page, and in dark `--accent-soft` alone is almost the same colour as `--raised`.

Replaced in part on 2026-11-08: Catalog is no longer a row, and Connections is a page of Settings (see "Metrics, Terms and Datasets at the root").

Stops being right when the settings pages fit the first lane (five or fewer), when an admin page
cannot be used in 536px, or when the tree needs more width than 268px gives: then the tree takes a
second lane too.

Before and after, on the sample tenant: [desktop](look/before-after-desktop.png),
[phone](look/before-after-phone.png), [the settings lane](look/settings-lane.png) with a row hovered,
and [the settings pages on a phone](look/settings-lane-phone.png).

## Metrics, Terms and Datasets at the root

**The first lane lists Search, Home, then Metrics, Terms and Datasets as rows of their own, with no Catalog row
above them; Status for an admin and Settings for everyone sit below. Connections is a page of Settings,
in an Account section that every person has and that comes before the admin's Data, Access and System.
Settings opens on Connections. The breadcrumb drops Catalog: Metrics / Sales / Net sales,
Datasets / Retail, Settings / PII. Search is a row that opens the search page, in place of the icon in
the lane's header; `/` still opens the search dialog, and Home stays the landing page.** Taken 2026-11-08 at Martin's asking ("there should not be a catalog
in the left nav bar"), as Secoda lists its resources at the root. The addresses stay (`/catalog/...`,
`/settings/connections`), because links to them are out in docs, bookmarks and the home page.
Connections is a person's own setting, so a viewer now has Settings too, with that one page; the admin
sections show only to an admin, as before, and the admin API still decides who may read them. The
section is called Account because Linear and Notion call a person's own settings that. The tree's
landmark keeps the name Catalog for a screen reader, which groups Metrics, Terms and Datasets under it.

Martin said "home should be Search", which could also mean Search replacing Home as the landing page,
with the onboarding steps moving elsewhere. Asked which, the answer was the smaller change and the easier
one to undo: a Search row first, with Home kept below it as the landing page and the onboarding page.

Stops being right when a person has more settings of their own than fit one section, when the
catalog's three parts need a page above them again, or when Search should be the landing page.

**Replaced in part, 2026-11-10.** Search is no longer a row, and Home is the search page, not a separate
landing page: see "`/` is the search" and "The lane's header holds the search button" below.

## Datasets fold down to the field, and load as they open

**Under Datasets the first lane folds Workspace, then Dataset, then its tables, then a table's
measures by display folder and its columns. Folders nest on `\`, as Power BI's do, and a measure in
several folders (`;`) shows in each. In a table, folders come first, then the measures in no folder,
then the columns. Every row that folds shows a count of what it holds; a dataset's count of tables
shows once it has been opened, because the list of datasets does not carry it and the tree asks for
nothing to count. A level is asked for only when it is opened: the datasets when Datasets opens, a
dataset's tables when it opens, a table's measures and columns when it opens; a list longer than 100
shows the rest on Show more, and the field on screen shows even past the 100th row. Only the way to
the dataset, table or field on screen opens by itself, the nearest folded row on that way is marked,
and a person's own opens and closes hold as they move. A field opens the diagram with its table's
panel and the field marked (`?table=...&field=...`). The dataset page's Tables and Measures tabs
draw the same rows, with each table's columns and measures counted apart and each field's format
string or data type at the row's end, as the lists there had before.** Taken 2026-11-08 at Martin's
asking, as Power BI's own Data pane folds a model. The api already had every field: `display_folder`
on measures, and measures and columns filtered by table, so no route changed. Columns carry no
display folder in the mirror, so they are listed flat. A dataset row with its count before it is
opened would need `table_count` on the list of datasets.

Stops being right when the mirror keeps columns' display folders (then columns fold too), or when a
table holds so many fields that 500 a page is too slow to fetch at once (then the tree pages them).

**Replaced in part, 2026-11-10.** The mirror now keeps columns' display folders, read from Power BI's
`INFO.VIEW.COLUMNS`. Only a connected person's model read reaches it, with that person's token, and only when
the folders are due (never read, or the schema changed since); the sync never reads them. The read runs
when a person opens a dataset, opens a column's page or lists a dataset's measures (a table's measures
too). A query starts it only when the caller lacks `pii_reader` on a dataset that has PII rules. And `GET /api/v1/datasets/:id/columns/:column_id`
answers one column. So columns fold by display folder like measures, and the "listed flat" sentence
above no longer holds. A table, a display folder and a column each have a page of their own:
`/catalog/datasets/:id/tables/:table`, `.../folders/:folder` and `.../columns/:column`. The folder route
carries Power BI's own folder path as one encoded segment, one backslash between levels (`Sales%5CMargin`),
so a link says what Power BI says. A splat would keep `/` and dot segments, and a folder name could then
move the link; one segment cannot. No link is built for a folder level, table or column named exactly `.`
or `..`; the name shows as text. The rest of
this section stands, 500 a page included.

Stops being right if Power BI stops answering `[DisplayFolder]` on `INFO.VIEW.COLUMNS`: columns then
fold into no folder and the folder pages list measures alone. `apps/web/src/catalog/datasets/column-page.test.tsx` holds the column page.

## The first lane resizes and hides, as Secoda's does

**From 1024px the first lane's right edge drags it between `--tree-width-min` (240px) and
`--tree-width-max` (480px), and the page always keeps `--page-min` beside the lanes. The lane hides
with the button beside search, with `[`, or by letting go of the edge under half the narrowest
width; hidden, a button at the page's top left brings it back. This browser keeps the width and
whether it is hidden. Below 1024px the lane is the drawer, as before.** Taken 2026-11-07 at Martin's
asking, copying Secoda: we walked its sidebar, whose edge is a 12px strip over the line with no mark
of its own, whose narrowest is 240px, and which hides outright rather than shrinking to a rail of
icons, with "Toggle sidebar" on `[` and a button before the page's title. A rail was the other
choice; the tree and Settings' sections have no icon to stand for them, so a rail would have been a
second, smaller navigation to keep in step with the first. `[` rather than Cmd+B or Cmd+\, because
it is the key Secoda and Linear use, it needs no modifier as `/` for search needs none, and Cmd+[
stays the browser's Back. Ctrl+Alt+[ counts too, because a Danish or German Windows keyboard types
`[` with AltGr, which the browser reports as Ctrl+Alt. The edge is a window splitter for a keyboard:
Tab reaches it after the lane's own controls, the arrow keys move it 16px and Home and End go to the
limits. The width is kept per browser, not per person as the theme is, because it suits the screen
rather than the account.

Stops being right when the tree needs more than 480px, when people ask for the lane as a rail of
icons, or when another shortcut on `[` is needed.

## Settings use the names people already know

**Pages and sections under Settings have the names other admin screens use: Authentication, Users and
roles, Service accounts, Limits, Audit log, and a System section.** Taken 2026-11-05 at Martin's asking,
checked against Snowflake, Mintlify, Shopify, Klaviyo and incident.io. Only the words on screen changed.
The addresses stay (`/admin/sign-in`, `/admin/people`, `/admin/limits`), because links to them are out
in docs and bookmarks and a new address is one more public path. The first run keeps "Sign-in" for its
own step, which is about signing in rather than this page. Conventions, Power BI, Datasets, PII, Secrets
and Search stay: the first is this product's own word in the CLI and the connector, and the rest are
already what people expect. Stops being right when a name here stops matching what the CLI and the docs
say for the same thing, or when testing shows people look for something else.

## On a phone, nothing moves the page sideways

**A field's text is 16px under `(pointer: coarse)`, every word may break anywhere except in a table,
a table too wide for its box scrolls inside it, and the drawer takes focus on itself.** Taken
2026-11-07 after Martin used production on an iPhone. /admin/secrets looked wider than the screen, yet
at 320 and 390px no element on the mock tenant passed the screen, in Chromium or WebKit. The likely
cause is iOS Safari: it zooms the page in when a field under 16px takes focus and stays zoomed, and
the SPA keeps that zoom from page to page. Fields were 13px, a zoom of 1.23, which leaves 317 of 390
pixels on screen: where the intro was cut and the Check button clipped. We could not run a real
iPhone, so this is reasoned from those numbers, not seen. `--type-field-touch` holds the size, beside
the six type sizes, because it is a browser's rule and not part of the type scale. `maximum-scale=1`
in the viewport tag would stop the zoom too, and it would also stop a person pinching to read, so it
is not used.

Separately, a long unbroken value did push a page wide: with a long name, /catalog measured 1067px at
390. `overflow-wrap: anywhere` on the body fixes that at the source, for every page, because unlike
`break-word` it also lets a flex or grid item shrink. Tables opt out, or a cell would squeeze to one
letter a line instead of scrolling. `e2e/mobile.spec.ts` checks every route with the sample's words
and with long ones.

`showModal` puts focus on the first link, which draws a ring on the logo as the drawer opens, so the
drawer focuses itself and the next Tab reaches that link with its ring. Below 640px the diagram has no
minimap: it covers a third of the pane and is too small to steer with a finger.

Stops being right when iOS stops zooming on small fields, or when a phone screenshot shows the page
still wider than the screen, which would mean the cause was something else.

## A breadcrumb on every page below a lane's top

**Changed on a phone, 2026-11-11.** Below 640px the breadcrumb is one link back to the nearest page
above, with a chevron, as Linear and Notion do on a phone; the page's own name is the heading under
it. On production at 375px every part of a metric's or a field's trail was cut to a few letters
("Finance P... / Finance - Inv..."), the condition this decision named for revisiting. From 640px
the trail is unchanged. A trail with no link above the page, such as Datasets / Retail, shows
nothing on a phone.

**Every signed-in page below a lane's top level starts with one line of breadcrumb: Settings / PII,
Metrics / Sales / Net sales, Datasets / Retail, Settings / Connections. Every part but the
last is a link. Home, Metrics, Terms, Search and Status have none.** (Catalog left the breadcrumb on
2026-11-08, with its row.) Taken 2026-11-05 at
Martin's asking, at the top of the page where the strip was. There is one component,
`apps/web/src/shell/breadcrumb.tsx`, which replaces the lines the metric, category, term and Not filed
pages each drew. A name in it comes from what the page has already read: the metric, category, term and
dataset pages draw it once that read has succeeded, so a metric the reader cannot see shows the same
not-found page as one that does not exist, with no breadcrumb. Settings pages draw it once the status
answer shows the reader is an admin. Search, Terms' list and Not filed hold fixed words. It stays on one
line at every width: the page's own name gives way first and shows whole on hover, a long name above it
gives way only when that is not enough, and a fixed word such as Catalog never does. The Datasets part
is text, because datasets are listed in the tree alone and a list page would be one more public path.
Settings is text on Power BI, the page it opens on, rather than a link to itself. The metric page's
Category property stays, because it is a field of the metric (phase 2 spec, item 9).

Stops being right when datasets get a list page, which that part should then link to, or when a deep
trail leaves no name readable at 390px.

## On a phone, a row is a list item

**Below 768px (640px for search hits) a row of a list or table puts its name on a line of its own
and its facts in a small line under it: trust under a metric or search hit, kind, type and metric
under a field, cardinality, filter and state under a relationship, with From over To.** Taken
2026-11-11 after a walk of production at 375px, drawing on Linear's and Jira's issue lists, which
keep status out of a column of its own, and on Attio and Notion, which turn a wide table into a list
on a phone. A trust column took a third of the width and wrapped a metric's name to four lines; the
field table showed only its name column with the rest off screen. The same table element is styled
both ways, so a screen reader reads a table at every width. DAX wraps on a phone, keeping its
indents, under a slim header whose copy button is the icon alone, as Perplexity and ChatGPT show
code; from 640px it scrolls inside its box as before. A long name in a title may break after an
underscore or a dot (`apps/web/src/shell/breakable.tsx`), not in the middle of a word, and the
drawer takes the screen less 3rem, so a metric's name in the tree reads whole.

Stops being right when a phone screenshot shows a row whose facts line is longer than its name, or
when people ask to sort or compare columns on a phone.

## Search is a dialog with a results page behind it

**Replaced in part, 2026-11-10.** The full results are no longer at `/catalog/search`: that address
redirects to Home, which is the search page (see "`/` is the search" below). The dialog stays, and its
first row now goes to Home with the words typed.

**Search opens from the first lane's icon or with `/` as a centred dialog. What was typed is the
first row and goes to the full results at `/catalog/search`; below it are the best hits by kind, by
arrow keys and Enter. No recent searches are kept.** Taken 2026-11-05, copied from Secoda at Martin's
asking. The field in the left column was too narrow for a hit's name and summary, and there was no
way to see more than the dropdown held. The address holds the search, so a result list can be sent
as a link. Secoda lists recent searches and popular resources when the box is empty; this stack has
no popularity to show, and recent searches kept in the browser would break `apps/web/AGENTS.md`'s
"the SPA keeps no data of its own" and show one person's searches to the next on a shared machine.
The page shows the api's best 50 with no paging, because search answers by rank and has no cursor.
Stops being right when people expect Enter to open the best hit rather than the list, or when
someone needs the 51st result.

On the sample tenant: [the dialog and the results page](look/search.png).

## Corners at 8px, and a flat page

**Controls, rows and tables round at 8px, and the search dialog at 12px. The page lies flat beside
the lanes with one line between them, on no sheet and with no shadow.** Taken 2026-11-05 by Martin,
who found the planner's 2px and 8px not modern enough. Measured on Secoda: 743 of its 747 rounded
elements on a page use 8px, one 12px. The values are in `packages/tokens`, so `apps/docs` and
`apps/site` follow. Metrics Book's copy of the tokens still has 2px and 8px; the two products differ
until it takes this version. Stops being right if the two products' designs diverge on purpose.

## Sample data is labelled

**While the stack runs on the mock tenant, the shell shows a "Sample data" band that links to "Move
to your own tenant" in the docs.** The label is at the tenant, not in the names: the band, `pbmb
whoami` and the MCP instructions say so, and the sample's names are plain (Sales, Finance), so
nothing called sample data is left behind when a company moves to its own tenant. Taken 2026-10-27
by Martin. Stops being right when the mock can no longer run in a development stack.

## No catalog UI in v1; the catalog phase starts with the dataset diagram

**v1 has no screen for browsing datasets. The first item of the catalog UI phase is a dataset page
with a diagram of its tables and relationships.** Taken 2026-10-27 by Martin, during the build. The
spec keeps a catalog UI out of v1: browsing the book is the agent's and the CLI's job. The data is
ready: the sync stores each dataset's relationships (from the scanner or `INFO.VIEW.RELATIONSHIPS()`),
and `GET /api/v1/datasets/{id}` answers them with `relationships_source` and `relationships_note`, so
the diagram is front end work. An earlier prototype's panel uses React Flow
with a dagre layout. The diagram must say when relationships are unknown rather than draw none. Stopped being
right on 2026-10-27, when the catalog UI phase was specced together:
`docs/specs/2026-10-27-phase-2-catalog-ui.md`.

## The catalog's screens were settled by looking at them

**The phase 2 spec's section "Settled by inspection" holds the catalog's look: the tree folded out
of the first lane, the diagram's lines and ends, how a large model reads, metric categories with their
descriptions, the admin Datasets and PII pages.** Taken 2026-10-27 by Martin, judging built screens
on the sample tenant, not from a description. A build agent follows them and does not re-derive
them. Stops being right when Martin judges a built screen and changes one; the spec is then updated
in the same pull request. The build's differences are recorded below; they describe the current screens.

## The catalog is built to be shared with Metrics Book

**Each catalog area lives in its own folder under `apps/web/src/catalog/`, and the diagram in
`src/catalog/diagram/` takes a neutral `DiagramModel` and imports nothing from `src/api`.** Taken
2026-10-27 in the phase 2 spec. Metrics Book's Phase 8 (its catalog) needs the same tree, category
pages and diagram, built the same way with the same words, as `AGENTS.md` asks of the two products.
A neutral model lets it map its own api onto the diagram. The diagram moves to a package beside
`packages/tokens` the day Metrics Book starts Phase 8; until then one copy here is cheaper than a
package nobody else reads. Stops being right if Metrics Book's catalog takes a different shape on
purpose.

## Suggestions name their reach

**The admin PII page's Suggestions section says "In datasets you can reach."** Recorded
2026-10-27 from `apps/web/src/admin/pii/page.tsx`. Suggestions use the datasets the admin may see,
including off datasets, just as rule coverage does. Without the sentence, a short list can look
like a tenant-wide inventory. `e2e/admin-pii.spec.ts` checks the sentence. Stops being right if
the suggestions API's reach changes; that test and the PII reach security tests must change with it.

## PII Undo preserves another admin's later decision

**Undo restores a PII rule only if the rule still has the expected version, and a conflict says
"Nothing was undone."** Recorded 2026-10-27 from `admin/pii/api.ts`, `admin/pii/page.tsx` and
`catalog/datasets/column-pii.ts`. Undo sends the saved version when replacing or deleting a rule,
or requires absence when restoring a removed rule. It records a new decision attributed to the
caller. `admin/pii/page.test.ts` checks the version and conflict message. Stops being right if
the API replaces conditional rule writes; retain the protection against overwriting a later decision.

## The diagram fits the pane on arrival

**The initial diagram scale considers both pane dimensions, between 60% and 100%, and starts at
the left edge if the model is still too wide.** Recorded 2026-10-27 from `catalog/diagram/layout.ts`.
The phase 2 spec described fitting the width; the build also considers height so a small model
fits whole when possible. A model taller than the pane at that scale starts at the top. A model
wider than the pane at the 60% floor keeps its first tables visible instead of centring on its
middle. `catalog/diagram/layout.test.ts` checks the fit and alignment. Stops being right when
the pane or minimum readable scale changes; rerun those tests and judge Retail at 1440px.

## Selection keeps a table in view without refitting

**The diagram fits once on dataset arrival, then pans only enough to keep a selected table in
view.** Recorded 2026-10-27 from `catalog/diagram/diagram.tsx` and `keepVisible` in `layout.ts`.
Opening a panel changes the pane's width. Refitting on every selection would move the whole model
and discard the person's zoom. The spec promised an arrival table in the middle; a model wider
than the pane instead starts left aligned and pans enough to show that table. The layout tests
check `keepVisible`, and `e2e/catalog-datasets.spec.ts` checks arrival with Order lines selected.
Stops being right if selection needs a different navigation model; recheck both tests and the
large-model screenshots before changing it.

## The diagram finds a table by name, and the address follows the selection

**The diagram's toolbar has a box that finds tables by name as a person types: a name's start first,
then a word's start, then anywhere, at most 8 hits. The arrow keys move through them, Enter or a
click picks one, and Escape closes the list, then clears the box, and only then clears the
selection. While a term is in the box, tables without it in their names fade, with the lines to
them. Picking a table selects it, opens its panel and brings it to the middle of the pane at 100%
zoom, or closer if the person had zoomed in; this is the one move that recentres, as "Selection
keeps a table in view without refitting" has it. Clearing the box ends the fade. After a pick it
leaves the view on the picked table, since the person is looking at it; with no pick since the
search began, clearing it, by its button or Escape, puts the view back where it was when the search
began. Escape clears the selection only on the diagram tab, and not when a dialog (search, the
phone's menu) or a field that uses Escape itself, such as this box, took it. Every selection now
writes `table` to the address (and drops `field` when the table changes), so a reload or a shared
link shows the same table.** Taken 2026-11-08 at Martin's asking, for models with more tables than
fit the pane. A pick recentres because the person asked for that table by name and may not see it at
the fit's zoom; a click on a table they can already see only keeps it in view. The search reads only
the model already on the page, so it adds no request. Stops being right when a model's tables are
found more by their columns or measures than by their names (then the box searches those too).

## A PII tag opens the rules page

**An admin's PII tag in the catalog opens the PII page without selecting a rule.** Recorded
2026-10-27 from `catalog/datasets/table-panel.tsx`. The spec described a link to the rule, but
the panel knows only that the column is protected, not which rule covers it. The admin finds the
rule in the list, where coverage and removal are shown. `e2e/catalog-pii.spec.ts` checks the link.
Stops being right when column metadata identifies the effective rule and the page can select it.

## Logos are uploaded raster images

**A logo is PNG, JPEG or WebP, never SVG and never fetched from a URL.** Recorded 2026-11-08. SVG can carry script; fetching a URL would add an outbound trust boundary. The admin uploads at most 256 KB, and the service reads the type from the bytes, ignoring the supplied content type. The public answer carries nosniff and a sandbox CSP.

Stops being right if another format gets an explicit rendering and fetch policy. `services/admin/branding_security_test.ts` holds type and size refusals; `routes/branding.test.ts` holds the response headers. Both live under `apps/api/src/`.

## Home is the search page

**`/` is the search: a box, and the results open under it in place, grouped by kind with counts, a Best
match card first, filters in the address.** Taken 2026-11-10 at Martin's asking, after the results page
of an earlier metrics catalog. With under two characters typed, Home shows the book's size (metrics, datasets, verified
and drafts), the setup checks and four fixed example searches; from two characters it shows the result
count in the box, a Type control and an "Add filter" menu (Trust, Workspace, Dataset, Category) and the
results. The words typed (`q`), the kind, the trust states and the three other filters all live in the
address (`/?q=net&kind=metric`), so a link or a reload shows the same page. Sections come in a fixed order:
Metrics, Metric variants, Terms, Categories, Datasets, Tables, Columns, each with its count from the api's
`counts`. Five rows show, then "Show all N" asks the api for that kind alone, 50 at most. Metrics,
Metric variants and Terms start open, and a lone section opens too. The Best match card shows only when the first
hit matched as `exact` or `words`: a hit found by meaning alone is not called best, as that catalog
withholds it below its 0.5 floor. No score is shown, because a rank-fusion score means nothing to a reader.
`/catalog/search` redirects to Home with its `q` and `kind`, so old links and bookmarks still land.

Stops being right if the api's `counts` stops being a count of the hits found (then a section's count and
its "Show all" disagree), or when people need recent searches, which would need storage per person.
`catalog/search/results.test.tsx`, `filters.test.tsx` and `home/home.test.tsx` hold the page.

## The setup notice is a button that goes away

**Setup is a small "Finish setup N of M" button beside Home's title, and it is not rendered once every step
is done.** Taken 2026-11-10. The checklist used to take over Home and never read as finished. The step that
could not close counted drafts; the sync drafts every measure it finds, so a real book always has drafts.
"Start structuring your drafts" is now done at one verified metric, agent or person. The button opens the
steps in a panel, the first open one unfolded. For an admin it waits for the people and role it counts
before it shows, so it does not flash "done" and then reappear.

Stops being right when a step needs a decision the panel cannot hold (then it is a page again).
`home/setup-notice.test.tsx` holds the count and the hiding.

## The lane's header holds the search button; Cmd+K and "/" open the dialog

**The first lane's header has a search button that opens the search dialog, and the lane has no Search
row.** Cmd+K (Ctrl+K) opens the dialog anywhere, and "/" does outside a text field, except on Home, where
both focus Home's own box, because Home already is the search. Taken 2026-11-10, as Secoda has it. In the
dialog what is typed is the first row and Enter on it goes to Home with the words; below it the best hits
open their page by the arrow keys and Enter. Home listens in the capture phase and stops the event, so the
dialog never opens over a page that is itself a search.

Stops being right if Home stops being the search page. `apps/web/e2e/shell.spec.ts` presses
Ctrl or Cmd+K.

## A table, a folder and a column have pages

**Each has its own address under its dataset: `/catalog/datasets/:id/tables/:table`, `.../folders/:folder` (one
encoded segment) and `.../columns/:column`, and the tree's table, folder and column rows and search hits
open them. In the tree, a measure and a dataset still open the diagram; a measure hit in search opens its
metric's page.** Taken 2026-11-10,
after an earlier metrics catalog and Secoda. A table page lists its measures and columns with a filter box; a folder
page lists one display folder; a column page shows the badges (Hidden, Calculated, PII), the description,
data type, format string, display folder, the DAX of a calculated column, its terms, the relationships that
name it and the measures whose DAX names it. A table is addressed by name, and a column by table and name,
because a person reads those; the page finds the column's id from the table's fields and asks
`GET /api/v1/datasets/:id/columns/:column_id`. The diagram stays one link away on the dataset page. A
breadcrumb names workspace, dataset, table and folders. The measures that "name" a column are found by
their DAX text, so a measure that reads it through a variable can be missing. Sample values are not shown:
they would need a query under the person's own rights, which is a later button.

Stops being right when the api answers a column by table and name (then the page makes one call, not
two), or when "used by" comes from the model's dependency view instead of the text.
`catalog/datasets/column-page.test.tsx` holds the column page.

**Replaced in part, 2026-11-19. The diagram is only the dataset page's. A table's name opens its page
wherever it shows: the tree, the dataset's Tables and Measures tabs, and the diagram's panel, whose
columns open their pages too. A measure in the tree opens its table's page on Measures, with the measure
marked (`?tab=measures&field=...`). A table page has Documentation, Columns, Measures and Relationships
tabs and opens on Documentation; a dataset page gains a Documentation tab after Diagram.** Taken at
Martin's asking: a table and a column are read like a catalog's entries, as Secoda shows them, and a
click that lands in the diagram loses the page a person meant to open. Documentation reads
`GET /api/v1/elements/:kind/:id/docs` and the conventions, and shows the description, Power BI's
description where it differs, each `element_fields` custom field, then the mirror's facts, in that order
on every kind, so the structure is the company's (rule 11) and no field is named in code. The Columns
and Measures tabs list every field flat, A to Z, with its folder, so the filter searches the whole table;
the first 100 show, as in the tree. "Show Order lines in the diagram" on a variant and "Show in the
diagram" on a term still open the diagram, since they say so.

Stops being right when the conventions give each kind its own fields (then the tab reads the kind's
list), or when people edit documentation in the browser rather than through `pbmb docs` and agents.
`catalog/datasets/table-page.test.tsx` holds the table page.

## Icons: five kinds, chosen by curators, drawn as text or a glyph

**Metrics, categories, terms, datasets and workspaces can carry an icon: one emoji, or a glyph from a
fixed list in one of eight colors. Only a curator or an admin sets it; tables, columns and measures keep
fixed icons by their type.** Taken 2026-11-10 at Martin's asking, as Secoda has icons. The picker has an
Emoji tab and an Icons tab, each with its own search box, a color row on the Icons tab and Reset. The
emoji list is loaded when the Emoji tab first opens, so it stays out of the first bundle. A glyph is
stored as a name, never as an image, and the SPA draws it from its own Lucide set in a `var(--icon-<color>)`
color. The value is `emoji:<emoji>` or `glyph:<name>:<color>`, checked by the service and again by the
database (`docs/security/threat_model.md`). An icon is how a thing looks, not what it means, so setting one
leaves a metric's trust state alone (`docs/decisions/book.md`). `pbmb icons set|clear|list` does the same
for agents. The lane, the lists, search hits and page headers all draw the icon, and fall back to the
kind's own when none is set.

Stops being right if a client wants an icon on a table or column (those kinds are not in the route), or
if a glyph name leaves Lucide (the list in `icon-glyphs.ts` and the SPA's map must change together).
`shell/icon-picker.test.tsx`, `shell/item-icon.test.tsx` and `icons_security_test` hold it.

## A metric's variants open folded

**On a metric's page each variant is one folded row: its measure, then its dataset and shift in a
small line under it. Opening a row shows its DAX and the link to its table in the diagram, and only
then loads the DAX. The variant in the address (`?variant=`, from a measure hit in search or a
field's metric link) opens by itself, highlighted and scrolled into view.** Taken 2026-11-11 at
Martin's asking. A metric with six variants filled two screens with DAX before Open questions and
History, and a reader picks a variant by its dataset and shift before reading its DAX. The row is a
button inside the variant's heading, with `aria-expanded`, as the lane's folds are, and the dataset
stays a link outside it.

Stops being right when a metric's page is mostly read for its DAX, or when people ask to open all
variants at once. `review/variants.test.tsx` holds it.

**Replaced, 2026-11-19. Every variant opens with its DAX showing, and its arrow folds it away. A
variant asks for its DAX as it comes within 600px of the screen, so a metric with hundreds of
variants does not ask for all of them at once.** Taken at Martin's asking: he wants a variant's DAX
visible without a click, which is the second condition above. The cost the fold was taken for comes
back: on a metric with many variants, Open questions and History sit below a long run of DAX.

Stops being right if that run of DAX hides Open questions from the people who need them; then those
move above the variants, rather than the DAX going back behind a click.

## Definition and each kind's fields come before Details

**Documentation shows Definition, Power BI's description when it differs, the kind's built-in fields, its custom fields, then Details.** Built 2026-11-19. This replaces the shared `element_fields` list above. Datasets answer which model to use; tables say what one row is; columns explain values. Definition uses the book's description, with Power BI's as a fallback labelled "From Power BI". Model facts stay in Details. `apps/web/src/catalog/datasets/documentation.test.tsx` holds the order and the fallback.

The built-in fields keep the same words as metric fields. Each kind has its own custom list in the conventions. The fields remain readable when optional; the conventions decide which are required. Curators write them through `pbmb docs set`, and `pbmb docs check` finds gaps.

Stops being right if most companies turn off the built-in requirements. The table definition rule stops being right if agents misread date tables without one; it currently exempts date and measures tables. An optional built-in dataset owner stops being right if companies mostly use their own owner field anyway.
