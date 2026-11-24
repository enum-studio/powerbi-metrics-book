# Metric documentation and the reading page

Taken on 2026-11-24. Mode: spec together, settled with Martin while the
same design was made for Metrics Book, the sister product. Built the same
way, with the same words, where the two products meet.

## Goal

A metric's entry answers everything a person or an agent needs before they
use the number: why it matters, what to use it for and not, which decisions
and actions it supports, what moves with it, how to cut it, who owns it and
who may see it. On top of those entries the book gets a reading page: a
curated way into the whole book, area by area, the most important metrics
first, that explains how the business works rather than listing measures.

The design is taken from a client's discovery site that documents 175
metrics this way, where nearly every field is filled for every metric and
each field earned its place on the site's metric pages. Its shape is used
here, not its content: the examples below are the sample tenant's.

**Done means:**

- The conventions declare the new fields, their values and whether each is
  required, and `pbmb metrics check` reports against them (rule 11).
- Every new field can be read and set through the curation API, `pbmb`,
  the metric page and, read only, the connector; every change is a
  `book_change` row (rule 7).
- A metric has a named owner, a person in the deployment, and people can
  follow metrics.
- The reading page shows the book area by area, as described below, and
  exports to Markdown and PDF.
- The sample tenant's metrics have every new field filled, so the public
  demo shows a full reading page.

## Non-goals

- Alerts and notifications when a metric moves. They need a query run on a
  schedule under someone's Power BI token, and rule 5 allows only the asking
  person's own; that is its own spec.
- PowerPoint export and a present mode. They follow the same switch as the
  exports below, in a later spec.
- Editing Power BI itself. The book documents; the model stays Power BI's.

## Settled by inspection (do not re-derive)

Martin approved these by looking at prototypes on 2026-11-24, for Metrics
Book. They hold here too.

- The reading page leads with the one sum behind every number, then one
  card per area with the area's question and its two or three headline
  metrics, then each area's metrics with the most important first and "Show
  all" for the rest, then one metric up close.
- "Moves with" is shown on a metric as a short list, the most important
  first, with "Show all".
- Exports are standard on every page and on by default; a deployment can
  switch each one off.

## Design

### 1. The fields

Today a metric has definition, aliases, when to use, not the same as, grain
and filters, unit, category, a free-text owner and custom fields. The
conventions gain these fields, each declared in `metric_fields` with
`required` and, for a choice, its values. The defaults below go into the
`metrics_book` preset; `minimal` leaves them optional.

| Field | Kind | Required in `metrics_book` | What it says |
|---|---|---|---|
| `tier` | choice: `north_star`, `driver`, `guardrail`, `diagnostic` | yes | its role: the headline, what moves it, what must not break, what explains it |
| `importance` | choice: `critical`, `high`, `medium`, `low` | yes | how far up its area it is shown; the critical ones are the area's headline |
| `importance_why` | text | when importance is critical or high | why it has that importance |
| `direction` | choice: `higher_is_better`, `lower_is_better`, `neither` | yes | which way is good |
| `use_for` | text | yes | what to use it for; replaces the first half of `when_to_use` |
| `dont_use_for` | text | yes | what not to use it for, and the metric to use instead |
| `caveats` | text | no | how not to misread it, and what to read beside it |
| `decisions` | text | yes | which team decides what with it |
| `actions` | text | no | when it rises or falls, what to check first and who acts |
| `primary_dimensions` | list of term names | no | the dimensions it is most often cut by, each a term in the book |
| `owner_team` | text | yes | the team that answers for it, such as Finance |
| `building_block` | boolean | no | a metric that exists to build others: left out of area lists, kept on the full list |

`when_to_use` stays for books that already use it; the `metrics_book` preset
moves it to `use_for` and `dont_use_for`, and `pbmb conventions upgrade`
splits existing text at the sentence that names another metric, leaving the
rest as a draft for a person or an agent to check. `not_the_same_as`,
`aliases`, `grain_and_filters`, `unit` and `category` are unchanged.

Fields the page depends on (`tier`, `importance`, `direction`, `owner_team`,
`building_block`) are columns on `metric`, with their allowed values checked
by the database from the conventions' current version (rule 3). The text
fields are columns too; the book's custom fields stay for what a deployment
adds of its own.

### 2. How metrics relate

Two new kinds of link, each a table with its own curation route and
`book_change` rows:

- **The sum** (`metric_edge`): a parent metric and its children, each with
  a sign, joined by sum or product, with an optional note. Gross profit is
  net sales minus cost of goods. The reading page draws the one sum from the
  edges of the area named in settings as the result (section 4).
- **Moves with** (`metric_link`): two metrics, how they move together
  (`same`, `opposite`, `depends`) and why, in one sentence. A link is
  written once and shown on both metrics; the reason on each side is the
  one written, or the other side's when only one was written. A metric's
  list is sorted by the other metric's importance, then tier.

### 3. The owner, a person

- A person gains a `title`, set by an admin or by the person, shown
  wherever they are named.
- A metric gains `owner_person`, a person in the deployment, beside
  `owner_team`. An admin or a curator sets it through the metric page,
  `pbmb metrics owner set <metric> <email>` or the curation API; it is a
  `book_change` row. A person who leaves keeps their name on the metric,
  marked as left, until someone is assigned.
- A person can follow a metric from its page or with `pbmb metrics follow
  <metric>`. That is their own setting, not a book change.
- **Who may see it** is generated, never written: from the metric's
  variants, the datasets they live in and the deployment's access rules, in
  words, such as "Anyone who can read the Sales dataset in Power BI". It
  cannot drift from the access it describes.

### 4. The reading page

A page at `/catalog/guide`, linked first under Metrics in the rail. Each
section is shown only when the book holds what it needs.

1. **One sum behind every number.** The edges under the result metric, as
   cards joined by plus, minus and equals; each card names its area and
   opens its metric.
2. **The areas at a glance.** One card per top-level category: a short line
   above its name, the name, the area's question, its headline metrics (its
   critical metrics, else its north star and drivers, at most three) and
   "N metrics in <area>". The category gains `question` and `kicker` for
   this; its order is its existing `position`.
3. **How to read a metric's name.** The parts of a key in order (kind,
   subject, qualifiers, VAT, currency), each kind with an example, read
   from the conventions' `naming` so it shows the deployment's own rules.
4. **Each area in full.** The area's description, then its metrics, most
   important first: name, definition, tier and importance. The first three
   are shown, then "Show all N". Building blocks are left out.
5. **One metric up close.** The metric chosen in settings, or the first
   north star: every filled field in a fixed order (why it matters, use
   for, don't use for, decisions, actions, primary dimensions, formula from
   its variant's DAX in words where the book has it, not the same as,
   caveats, aliases, who may see it, owner), then what moves with it, six
   shown, then "Show all".
6. **The glossary.** Terms grouped by a new `group` on the term (such as
   "Name patterns"), each with its definition and related metrics.

A link from any metric name opens that metric's page, which shows the same
fields in the same order. A deployment chooses the result metric and the
up-close metric in settings; an admin can turn the reading page off.

### 5. Exports

Markdown and PDF on the reading page and on every metric page, on by
default, each switched off by an admin setting (`exports.markdown`,
`exports.pdf`). Markdown is built from the book: headings, every metric with
its key, definition and fields, the glossary. The connector returns the same
Markdown from a new `read` kind `guide`, so an agent reads what a person
reads. PDF is the page printed by the browser from a print stylesheet; no
server renderer is added. An export reads only what the person may see, and
each export is logged as a usage event.

### 6. The connector and the check-in

- `read` returns the new fields, the links and the owner for a metric.
- A new read tool, `my_metrics`, returns the metrics the signed-in person
  owns or follows, each with its tier, direction, documentation fields and
  the pages to open. With `with_values: true` it runs each metric's current
  and previous-period variants under the person's own token (rule 5),
  through the query service, so an agent can answer "how are my metrics
  today" and explain the movement from the documentation.
- The connector still never changes the book (rule 7).

### 7. Checks

`pbmb metrics check` and the book's checks report, from the conventions: a
missing required field, a value outside a choice, a `primary_dimensions`
entry that is not a term, an edge or link to a metric that does not exist,
an edge that makes a cycle, and a link from a metric to itself. Each report
names the field, the rule and a fix, as the existing checks do.

### 8. The sample tenant

Every sample metric gets the new fields, edges for its one sum, at least
two "moves with" links each, a title and owner on each sample person, a
question and kicker on each top-level category, and term groups. The
public demo then shows the whole reading page.

## Security

New routes (links, edges, owner, follow, guide, exports) each check their
own credential and have an authorization test. `my_metrics` with values runs
under the person's delegated token only. The owner and title are personal
data: shown to signed-in people of the deployment, never in the public demo
beyond the sample people. Update `docs/security/threat_model.md` for the
new routes and the connector tool.

## Decomposition

1. Conventions: the new `metric_fields`, the `metrics_book` defaults,
   `pbmb conventions upgrade` for `when_to_use`. Python and the API's
   conventions service.
2. Database and curation API: the columns, `metric_edge`, `metric_link`,
   `owner_person`, follow, `title`, category `question` and `kicker`, term
   `group`; routes and `book_change`. Security review.
3. `pbmb`: set and read every field, links, edges, owner, follow; checks.
4. The metric page: every field in the fixed order, moves with, owner.
5. The reading page and its settings.
6. Exports: Markdown (and the connector's `guide` read), PDF print styles,
   the settings.
7. The connector: `read` with the new fields, `my_metrics`. Security review.
8. The sample tenant's content, and the agent evals that read it.

Tasks 1 and 2 come first; 3 to 7 can run in parallel on separate files once
the API exists; 8 follows the fields.
