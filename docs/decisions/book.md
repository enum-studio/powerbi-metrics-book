# The metrics book

Taken in the spec of 2026-10-25, during the build (2026-10-25 to 2026-10-27), or later, as each says.

## The book lives in Postgres

**The book is rows in Postgres, changed through the curation API (CLI, REST) by curators, every
change recorded in `book_change`; `book.yml` exports it for git.** Taken 2026-10-25 (review item 3).
Metrics Book keeps definitions in git because they are code. Here they are documentation about
measures that live in Power BI, and agents curate many at a time, which a database with an audit
table serves better than pull requests. `book_change` stays insert-only. Categories and terms are
written only by the api; the worker reads them to build search documents. `importBook` is additive:
it adds and changes what the file holds and never removes what it leaves out, needs the admin action
for each kind it changes, and writes its audit lines after commit with one `import_id`. Stops being
right if companies want review by pull request before a definition changes.

## Conventions, not a standard

**Naming, the description shape, variant axes, drafting and verification are the company's, set
through the CLI. Metrics Book's standard is the `metrics_book` preset and the default; `minimal` is
the other.** Taken 2026-10-25 (review item 17): this product reads models it does not own, so it
adapts instead of enforcing. No rule lives in code: the conventions gained five keys beyond the
spec's YAML for that (`naming.qualifiers`, `naming.money_qualifier.units`,
`not_the_same_as.ignore_words`, `term_fields.definition`, `term_fields.values`), and the image ships
`conventions/presets/`. A company may set its own qualifier groups; only the groups in
`qualifier_order` need words. A required field that is empty or whitespace counts as missing
everywhere. Stops being right when a check needs a rule the YAML cannot say.

## `human_verified` comes from a person in a browser

**Only a person can set `human_verified`. By default that means a browser session;
`trust.human_verify_from: any` widens it to the person's token (MCP, CLI, API), never to a service
account. A change to any `trust.*` convention also needs a browser session.** Taken 2026-10-25
(review item 7) so an agent holding a person's token cannot claim a person's sign-off. The last
sentence was added in the build: an admin's token could otherwise set `any` and approve with the
same token, so a metric became `human_verified` with no person present. The code enforces it, with
a security test. Residual risk, in the threat model: a token with `edit_conventions` can turn checks
off, after which `agent_verified` means less; every change is in `book_change`. Stops being right
if the CLI gets a sign-off a browser cannot fake, such as a passkey prompt.

## Dismissed drafts

**A measure that is not a metric leaves the book with a reason, outside the three trust states
(`draft`, `agent_verified`, `human_verified`).** Taken 2026-10-25 (review item 8). A fourth state
would put a trash heap in every filter. A dismissed draft leaves search, and the sync never drafts that measure again unless its expression changes. Stops being right if curators want to see and restore
dismissed drafts in a screen.

## A merge, and what a curation answer may say

**A curation answer names only what the caller may describe: a check names labels of metrics the
caller can see, and a refused merge names describable measures and datasets and counts the rest.**
A message that named a hidden measure would leak a dataset the caller cannot see. Locks on metrics
are taken in id order before variants, because two opposite variant moves, and the drafter against a
curator's move, deadlocked in the build; race tests hold it. Stops being right if a caller can see
a metric without being able to describe its measures.

## Embeddings follow the book's changes

**Every `book_change` queues one `embed` request in the same transaction (at most one queued at a
time), and the job rebuilds only those elements' documents.** The spec re-embeds "on the next sync",
which would leave a curated description unsearchable until then. The sync's own run still rebuilds
everything and compares hashes, because mirror changes write no `book_change`. Details in
`search.md`. `worker_rw` may delete from `event` for the 90-day retention. Stops being right if
embedding stops being queued by the database.

## A curator's read costs what its page names

**The queue and a metric's page read what they name, not the book: one statement for every draft's closest metrics, the measures a name or a calculation can pair with, a PII measure from its rule, and a metric found before its visibility is asked.** Taken 2026-11-04, when those routes took seconds on a deployed stack with nothing else running. Compiling was part of that, and `architecture.md` turns JIT off: the planner prices `visibleMetric` as if it ran row by row, so any statement over the whole book passed `jit_above_cost`. The rest was how many statements a page ran and how much each read. On 10,000 invented measures and 9,000 drafts with JIT off, for a caller without `pii_reader`, timed in turn on a laptop at a load average of 25 to 42, the queue went from about 2,000 ms to 480 ms and a metric's page from about 420 ms to 210 ms. In their final form, at a load average of 11, they take 173 ms and 55 ms, and at 100,000 measures 411 ms and 132 ms. `test/large-book.ts` seeds that book and `src/services/book/reads_at_size.test.ts` holds the statement counts and plans on it; there is no stopwatch in a test, because a shared machine would make one flaky. The trigram, name and fingerprint indexes live in `src/db/sql/book.sql`, because they came when a deployed database could take no new migration; a new index goes in the schema. A read of one measure asks its PII rule by the measure's key and folds one name, so its cost does not grow with the mirror. A read of many usually folds each name once per statement. `dataset_count` in `listMetrics` asks per metric instead and folds the rules each time: a page of 200 takes 1,050 ms with 5,033 measure rules, where a read that folds them once took 96 ms, 106 ms against 42 ms with 500 rules, and 84 ms against 171 ms with 33. That stays, because only an admin adds a rule, and it hides nothing. There is no index on the fold, on purpose. An index would save 63 ms on the queue and 14 ms on a metric's page on that book, and 287 ms and 86 ms at 100,000 measures, for a caller without `pii_reader`, but after a Postgres major or glibc upgrade a stale one lets a measure out of its rule: the measure and a metric held only through it show, and its name and description reach search and the embedding provider, which no reindex recalls. The rules are folded under `offset 0` for the same reason: with many rules the planner would otherwise read `pii_rule_name_idx` by the fold, and a stale copy misses the rule. `rule_index_security_test.ts` holds that. Search names `piiMeasure` three times in one statement, which on that book costs no more than before. A stale trigram or words index can change a suggestion or cost a page a warning, and shows nothing hidden. A metric's page narrows the labels it reads with `ilike`, so a letter the database does not lower as Node does (one newer than its glibc, or any non-ASCII letter under `LC_CTYPE=C`) can drop a label the check would have matched: a missed warning, and nothing revealed. A dropped label would also pass the check, so verifying, approving and the checks route read every label. `suggestMerges` and `suggestSameNames` fold names in SQL only to narrow what they read, and compare with `wordsOf` as before, so a name Postgres folds apart from JavaScript can lose a suggestion or change which pair a draft's limit of ten keeps, always among measures the caller may describe. Stops being right if the book outgrows what one hash of its variants per statement can serve (`summarizeBook` and the closest metrics still build one), or a deployment holds thousands of measure rules.

## A check counts the metrics it names, and lists them apart

**`metric_not_the_same_as` says how many other labels share a word, and `other_labels` in the check's
answer lists them, closest first.** Found 2026-11-04 walking a real deployment: one metric's sentence named hundreds of
labels, shown twice on the metric page, with what to do at its very end. `GET /metrics/{name}` and the
connector's `get_metric` name the ten closest, because agents read them; "A curator's answer costs what an
agent decides on" has the bytes. `GET /metrics/{name}/checks` lists them all, and the metric page reads it to show
the first five and a button. `pbmb metrics show` prints the ten closest and `pbmb metrics check` prints them all.
A refusal to verify says the count. `checks.test.ts` and `check-message.test.tsx` hold it, and `pii_visibility_security_test.ts` and `curator_counts_security_test.ts` that a hidden metric stays out of the list. Stops being right if a
second check needs a list of its own, when the field needs a name that is not about labels.

## What folds a draft

**A measure folds under another metric only on proof from its DAX: the same text after rewrites that
cannot change the result, or a shift the patterns can read. A name alone is only ever a suggestion.**
Taken 2026-11-04, after the first sync on a large tenant left one draft per calculation, far more than
a curator can work through. The patterns could not read many ways of writing a shift: variables, extra
brackets, filters on a calendar table's own columns, a zero for a blank, and a slicer choosing between
two date roles. Grouping by name was rejected: a name is no proof, and a variant is the same calculation
shifted, so a wrong fold breaks what a variant promises.

Four things count as proof, and each has its tests:

1. **A rewrite that cannot change the result**, in `apps/api/src/dax/simplify.ts`, on each measure
   before expansion. A VAR is evaluated once, where it is defined, so it is written out only where
   the context is still that one. Under `CALCULATE`'s first argument or an iterator it stays a
   variable. Brackets that bind nothing go, and variable names stop mattering. Expansion writes a
   reference as `CALCULATE(...)`, because that is what it means: `SUMX(T, [m] * 2)` transitions the
   context, and `SUMX(T, (SUM(a) - SUM(b)) * 2)` does not.
2. **A period shift**: one measure under date filters on one table, in `apps/api/src/dax/variants.ts`.
   `DATESBETWEEN(d, MIN(c), MAX(c))` takes its period from the words in the name of another column `c`,
   and those words are `drafting.period_words`, not code. A period read that way must not be
   contradicted by the measure's own name. `IF(SELECTEDVALUE(...) = "x", shift, shift)` counts when
   both sides are the same shift of the same measure.
3. **A comparison** over `[B]` and a period shift of `[B]` proven the same way.
4. **A shift composed of shifted measures**: `DIVIDE([Num LY], [Den LY])` as the shift of
   `DIVIDE([Num], [Den])`, when one filter shifts them all. Its rule has its own section below.

What must stay apart has its own tests in `simplify.test.ts` and `variants.test.ts`, and on the sample
tenant in `EXPECTED_NOT_GROUPED`: a measure kept in a variable under `CALCULATE`, which holds this
period's value; the same shift with one more filter; another column cleared with no calendar read, which
drops that filter; a cleared table that holds the measure or that the base names, which is no calendar; a
clear of a measure, which is no column; a calendar column that disagrees with the name. A table that holds neither measure and that the base never
names, with a column named for a period, is taken for a calendar: `ALL(Customer)` beside
`Customer[Signup LY]` would pass, and only the relationships could tell it apart. The same name on another table stays two drafts. The sample has 91 measures and
47 live drafts: `Order lines` and its six long-form shifts are one draft, and four near misses stay out
of it.

**A `DATEADD` and a calendar column together are one shift, when they are on one column and say one
period.** The filters intersect, so if the column does not hold what its name says, the measure covers
fewer dates than the period, and on a calendar a few days off from `DATEADD`, a single day can come back
blank. A code review asked to refuse the shape for that reason. It stays, because reading a column alone
trusts its name in the same way, because filing does not change a measure's numbers, and because the
shape is a common template: refusing it undoes much of the folding on a large tenant, for a risk no
measure there showed. Stops being right if a curator finds such a variant whose numbers are not its
period.

**A zero for a blank is the same calculation on a shift only, and the variant says so.**
`COALESCE(shift, 0)` and `DIVIDE(a, b, 0)` differ from the plain form only where the calculation is
blank, and the variant's `shift_note` states that. A comparison against such a shift carries the note
too. `DIVIDE(a, b, 0) - 1` carries none, because a blank less 1 is -1 as 0 less 1 is. On a base variant
it would break the promise that every base variant of a metric gives the same result, so
`COALESCE([m], 0)` stays its own draft. `drafting.recognise_blank_as_zero` turns this off.

**A metric holds one variant per shift in a dataset, so a second calculation in a held shift stays its
own draft.** What holds a shift now keeps it, so a new measure never takes it away. Among the rest the
plain form goes first, so one that shows 0 for a blank gives way. A second measure of the same
calculation is filed beside the first, because the two give one result. One that loses its place never
takes the draft from the base it was filed under.

**Each sync drafts every dataset that is on, not only the changed ones.** The conventions and the
drafter's own rules change without Power BI changing, and a rule should reach the whole book. A run with
nothing to do writes nothing. A dataset turned off is read again only when it changes, so an admin can
stop the worker reading a crafted one. A book drafted under older rules folds at the next sync, and a draft of a curated
metric's calculation may gather under it at the sync after, once that metric's measure has its new
fingerprint. Writing a reference as `CALCULATE` changes the stored fingerprints once, so an untouched
draft that spans datasets may leave that sync under a new id and key, as each dataset moves to the new
fingerprint in turn. The same happens when a shared model is edited in every copy. Each move records a `book_change` and an event once, and no filing the sync may not move
changes: only a sync's filing under an untouched draft moves, as before (repo rule 9, `drafter.test.ts`).

**A shift of a measure a curator filed takes that metric, and the currency and custom axes the curator
gave the measure.** Taken 2026-11-09. Curators had filed most bases in a currency, such as an `EUR`
measure in `EUR`. The drafter counted a filing as a base only with no currency, so every shift of such a
measure went to a draft of its own. The shifts that sat in the draft the base was moved out of left it
the same way, each for a draft named after itself, and a curator moved each one back by hand. A curator's filing with no currency was never affected: its
new shifts were filed under the curator's metric, as `drafter.test.ts` shows.

A currency or a custom axis says nothing about time, so `CALCULATE([Net sales EUR], DATEADD(...))` is in
`EUR` because its base is, on the same proof as any shift. The sync still sets no currency of its own: a
shift takes it only from a base a curator filed. This adds a variant to a metric a person holds, and
repo rule 9 forbids moving a curator's filing, not adding beside one. Both were already true for a base
with no currency; the curator's metric and its filings are not changed, and the new variant is the
sync's, recorded in `book_change` and the event feed as `file` or `move`. A curator who disagrees moves
it, and it is then theirs. The slot rule holds on every axis: the shift stays a draft of its own when
another calculation holds that period, comparison, currency and custom axes in that dataset, and a shift
in `EUR` goes beside the same shift with no currency. A base a curator filed as a shift itself, such as
`year_to_date`, takes no shift of it, because what last year of a year to date is would be a guess.

Not covered: a copy of a curated base in another dataset still joins only a curator's base with no
currency, so a new copy of an `EUR` base stays a draft. The drafter finds such a copy with `standsAlone`,
which wants no currency, and so do a metric's base variants, the `metric_base_variant` check and the
merge suggestions. Letting a currency in there would change those three reads too.

Stops being right if a curator gives a base a custom axis that a shift of it does not share, which would
show as curators moving these variants back out. A shift filed this way keeps its currency if a curator
later changes the base's currency: the metric is the curator's, so the sync does not decide it again, and
a person moves it.

**A dataset that cannot be drafted leaves the others going, and the sync ends as failed saying so.** With
every dataset drafted on every sync, one that throws would otherwise stop the rest, and the embedding
that follows, every time. Its transaction rolls back, `drafts_failed` counts it, the run names it by
id, and the worker's log holds the reason.

**A measure time-shifted without proof of how files as period `other`.** Taken 2026-11-07. It stayed its
own metric as period `current`, so a growth measure over last quarter told a reader it was the current
period, which is false. A measure gets `other` when no pattern proves its shift and either its DAX, with
its measures written out, calls a function that reads another period or more of one, or its name holds
a word of `drafting.name_hints.period` or `drafting.period_words`. `LASTDATE`, `ENDOFYEAR`,
`CLOSINGBALANCEYEAR` and their like do not count: they pick a date inside the selection, which is what a
stock's closing figure is. Time intelligence turned off, or a period axis without `other`, files
`current` as before.

The fold does not change, and a test compares the sample's folds with and without `other`. The drafter
reads a sync's `other` as it read a sync's `current` everywhere it decides a fold (`standsAlone`), and so
do `suggestMerges` and a metric's `base_variants`, which now say each entry's `period`. A curator's
`other` stays a shift a person chose. A filing the sync may not move keeps its period (repo rule 9).

What does change: it can merge into a metric holding the same dataset's `current`, where the two used to
clash, and two `other` in one dataset do clash. On a book drafted earlier, the next sync updates each such
variant once and counts it in `regrouped`. A proven shift that lost its place stays its own draft as
`current`, because the drafter can prove that shift and `other` would say less. Stops being right when
readers need a separate word for "base of a draft" or that last case misleads someone.

**`metric_base_variant` passes for a metric that holds `other` and no `current`.** Taken 2026-11-07. The
check wants a live `current` variant, and a metric holding only `other` has none, so it could not be
verified or approved: the only ways through were a false `current` or turning the check off. `other` says
no measure computes the metric unshifted, so the metric holds all the base the book can know. The check
now passes when a live variant is a base or is `other`. A metric holding only proven shifts
(`previous_year` and so on) still fails, because a measure that computes it unshifted exists somewhere
and is not filed. A merge keeps each variant's `assigned_by`, so a sync's `other` moved by a curator is
still a sync's and still gathers later copies; the kept metric is touched, so the sync still does not
move it (repo rule 9). Stops being right when `other` is used for something a reader would not accept as
a base, or when a curator's merge should count as choosing a period.

**A dataset's first draft costs a few statements a measure, and no limit stops it.** Taken 2026-11-07, on
a dataset of 33,000 invented small measures, by hand, on a shared laptop at a load average of 7 to 16.
Its draft took 300 s, with 150 s in one statement: `uniqueName` matched a pattern, which read every
metric, once per draft. That statement took 5.8 s at 5,000 measures, 43 s at 15,000 and 150 s at
33,000. It now asks for exact names through the unique index, with no new index or migration: 19 s at 33,000,
about 0.6 ms a call whatever the size, and the draft took 181 s at a higher load. The rest is proportional, about
six statements a measure, about 0.6 ms each. A sync that changes nothing went from 12.8 s to 4.9 s, because
the drafter no longer filters every draft's members per group. No `statement_timeout` applies to the
worker, a job has no limit on its running time, and the heartbeat runs between statements; the 10 minutes
in `max_wait_ms` only makes a second job of that name give up. Meanwhile the transaction holds the
drafter's lock and that dataset's metric rows, so a curator's change to one of those waits. Each list
goes in as one array parameter (`anyOf`, `noneOf`), and `drafter.test.ts` and `sync.test.ts` compare a
statement's binds at 50 and 500 measures instead of drafting 33,000. The event feed's insert grows up to
`ROWS_PER_STATEMENT` rows and is cut there. Stops being right if a first draft must not hold those locks
for minutes, which would call for batching the per-measure statements.

**A measure's DAX is untrusted, so the work it can cause is bounded.** Anyone who can publish a model
writes what the worker reads on every sync. A measure whose DAX or expansion passes 500,000 characters,
or whose references go past 200 levels, is recorded with that sentence as its error and the sync files
nothing for it; a filing a curator made stays. The limit is in characters, because one literal read many times grows by its length. A rewrite
stops at 20,000 tokens or 100 variables, or at a variable name used twice, and leaves the measure as
written, so it still has a fingerprint. Each measure is read once for its dataset, however many reach it, while the readings kept fit
500,000 tokens, and the worker's event loop turns between measures, so its heartbeat runs however many a dataset holds.
`crafted_dax_security_test.ts` and `crafted_measure_security_test.ts` hold these. Many measures near the
limits can still keep one sync running long, on each sync, until the dataset is turned off. The largest
measures measured on a real tenant stay far below every limit. Stops being right if a real measure
reaches one, which its `fingerprint_error` shows.

**A generated draft takes back the name it wanted once that name is free.** Folding empties the draft
that held `order_lines`, which would otherwise leave `order_lines_2` for no reason. The rename records
a `book_change` with no event, as the drafter's delete and dismiss do. A draft a curator touched keeps
its name.

**Two metrics holding a measure of one name, or a base measure of one fingerprint, are suggested as a
merge, each pair once, proof first, at most ten for a draft, and only among measures the caller may
describe.** So a hidden measure neither shows nor hides a pair, and no count says one exists. The
word-based suggestions keep `hidden_suggested_merges`.

**A measure built from shifted measures is a shift of the base when one filter shifts them all.** Taken
2026-11-05, for ratios such as `DIVIDE([Num LY], [Den LY])`, which stayed drafts of their own. A filter
around arithmetic reaches each measure in it, so `CALCULATE(DIVIDE([Num], [Den]), F)` and
`DIVIDE(CALCULATE([Num], F), CALCULATE([Den], F))` are one calculation. Three things must hold, in
`matchComposed`:

1. **The base is the measure's text, whole, with each measure replaced by the one it shifts.**
   `DIVIDE([Num LY], [Den LY]) * 100` shifts `DIVIDE([Num], [Den]) * 100` and nothing else, and
   `DIVIDE([Num LY], [Den LY])` is no shift of it. A shift that writes no such base stays its own draft.
   Where two measures write the base, the first by name is the base. If a rule keeps that one out of the
   book, the shift goes under another measure of that calculation, or stays its own draft if none is left.
2. **Only arithmetic sits between the measures: literals, `+`, `-`, `*`, brackets and `DIVIDE`.** A filter
   would reach nothing else in the text. `DIVIDE([Num LY], SUM(T[c]))` is last year over this year, so
   it is no shift of `DIVIDE([Num], SUM(T[c]))`, and the same goes for a measure left unshifted. `IF`,
   `COALESCE` inside the calculation and every other function stay out, as they can tell a blank from 0.
   So does a slash: a blank over a blank is blank and `0 / 0` is NaN, so a zero for a blank could show
   NaN where the note says 0.
3. **One filter, not only one period.** The shifts' texts must match, but for the measure each shifts
   and a zero for a blank. `SAMEPERIODLASTYEAR` and `PARALLELPERIOD` are both `previous_year` and cover
   other dates on part of a month, so the sample's `Average order value LY` would divide the first half
   of a January's sales by a whole January's orders. A date column, a slicer's test and a calendar
   column are part of that text too. A column written bare is read with its measure's own table, as
   `[Date]` on two home tables is two columns. `SAMEPERIODLASTYEAR` beside `DATEADD(d, -1, YEAR)` stays
   apart as well: a missed merge, and the slot rule already treats those two as two calculations.

**A zero for a blank on a composed shift is judged against the base.** The same alternate result on both
is the same calculation: no note, and it folds with `drafting.recognise_blank_as_zero` off. Over a base
with none, a `, 0` on the shift's whole `DIVIDE`, a `COALESCE(..., 0)` around it, or a shift it reads that
shows 0 carries the note and needs that setting. A zero on the whole calculation shows only where the base
is blank. A shift it reads that shows 0 sits inside the calculation, so the operators above it decide. `+`,
`-` and `DIVIDE` turn at most a blank result into 0: blank and 0 add alike, even to infinity and NaN, and
`DIVIDE` gives a blank for both below the line.

**A measure's own zero stays out from under a `*`.** `*` does more than show a blank as 0. A measure can
be infinite or NaN through a slash inside it, and a blank times either is a blank where 0 times either is
NaN. With `Rate := [C] / [U]`, `1 + [N LY or 0] * [Rate LY]` would be NaN where `1 + [N] * [Rate]` is 1, and
a filing would promise one number for two. So a shift it reads that shows 0, or a measure that carries such
a zero on, keeps a measure whose text holds `*` as its own draft, anywhere in that text. `[N LY or 0] * 100`
stays apart too, though its factor is finite: a missed merge, for one rule that needs no parsing. We ran
this as literals in Power BI on 2026-11-05: `BLANK() * (1/0)` and `BLANK() * (0/0)` give a blank, `0 * (1/0)`
and `0 * (0/0)` give NaN, `DIVIDE(BLANK(), 1/0)` gives a blank and `DIVIDE(0, 1/0)` gives 0, and `DIVIDE`
below the line gives a blank for both, with infinity and NaN above it.

A base that shows 0 where the shift does not, or another alternate result, gives other numbers where the
base is not blank, so that stays its own draft. A `, 0` inside more arithmetic, as in
`DIVIDE(a, b, 0) * 100`, is not read: a missed merge. Where `DIVIDE(a, b)` and `DIVIDE(a, b, 0)` are both
measures, a shift goes to the base with its own alternate result. A zero below the line changes nothing, as
`DIVIDE` gives a blank for both, and the variant still carries the note. That says more than is true and
hides nothing, as a growth rate against a shift that shows 0 does.

**The slot rule treats a composed shift like any other.** `CALCULATE([Ratio], F)` and
`DIVIDE([Num LY], [Den LY])` give one number and have two fingerprints, so what holds the shift keeps it
and the other stays its own draft. That is a missed merge.

**A new copy of a base leaves a shift of it where it is.** A new measure that writes the base and sorts
first becomes the base a composed shift names, and it has no filing yet. So `decide` asks whether a shift
sits on a live metric that has its base's calculation as a base, by fingerprint, and not where the named
measure is filed. Measures that write one calculation to the letter count as one base for a comparison
too, so `[Ratio] - [Ratio LY]` stays a comparison when the copy arrives.

Two things still move when a copy arrives, and both are missed merges whose numbers stay right. A measure
built on a composed shift, such as `[Gross margin % PY] * 100`, then looks for a base written with the
copy's name, finds none, and goes back to its own draft along with what compares against it. With
`drafting.group_by_fingerprint` off, the copy has a draft of its own and the shift moves onto it. Comparing
by a measure's calculation and not its name would fix the first, and needs a second reading of the whole
dataset. Stops being right if curators keep refiling these.

**A composed shift's proof can lapse.** Remove `Gross margin PY` and `Gross margin % PY` goes back to a
draft of its own at the next sync, along with what compares against it. Only a sync's filing under an
untouched draft moves, as ever (repo rule 9, `drafter.test.ts`).

**A composed shift, what it reads and its base are at most 4,000 characters of DAX, as written and as
written out.** Looking for a base reads every measure of the dataset, so a long measure stays out, and so
does a short one whose variables write it out long, as 4,000 characters can write out to 16 MB. A digest
of what each measure writes is held, not its text: 72 characters of variables write out to 6,817, which
at 120,000 measures ran out the worker's memory. The drafter reads them before its analysis, one at a
time, with the event loop turning between them. `crafted_dax_security_test.ts` and
`crafted_measure_security_test.ts` hold this. A longer real one stays a draft.

Stops being right if a shift filed this way gives a different number from the calculation it claims to
shift, or if Power BI changes when a VAR is evaluated. Running both in Power BI would show the first;
the keep-apart tests hold the reasoning. The composed rule stops being right if `DIVIDE([Num LY], [Den LY])`
and `CALCULATE(DIVIDE([Num], [Den]), F)` ever differ in Power BI. The zero rule stops being right if Power BI
changes what those literals give. It is too narrow if curators keep filing by hand what it refuses: a
slash, a measure's own zero times a literal, or two spellings of one filter. The slot rule stops being right if a
metric may hold two variants of one shift in a dataset.

## A draft's name comes only from what its readers may see

**A generated key and label reach a reader only when that reader sees a measure of that name. Measures of
one fingerprint in one dataset share a draft, named from one of them that is not PII. A measure in another
dataset joins it only under the same name in snake_case. Two names of one fingerprint across datasets stay
two drafts, offered as a merge with `"axis": "calculation"`.** Taken 2026-11-05. Anyone who can see one
variant reads a metric's row, and folding by fingerprint named one metric from the first dataset drafted,
so a reader of Finance alone read `net_sales`, a name from Sales, a dataset they cannot see. PII behaves as
if it does not exist, and an off dataset stays hidden, so neither may name a draft someone else reads.

Three ways out were rejected. Keeping the fold and a name per reader needs every list, sort, prefix filter,
reference, search document and event to know the reader; one missed is the same leak, and a key that means
different metrics to different readers cannot be pasted between them. A neutral key such as
`calculation_ab12` closes it but tells an agent nothing, and renames `net_sales` the day a copy under
another name appears. Accepting the leak as a residual risk breaks what the threat model says about off
datasets and PII. The cost is drafts: a pair of one fingerprint stays apart until a curator merges it. Only a
person can make that decision: it needs a name, and one fingerprint says the text is the same, not the rows behind
it. The offer is one entry for the two names under the two metrics, as any likely merge is, and counts towards the
same limit of ten as a pair of the same name. Its read sees only what the caller may describe, so no hidden measure
can name, hide or count in an entry. The order of its groups can follow a visible measure's id. A draft's own
`dataset_count` counts hidden datasets and orders the queue, so a hidden copy can change which drafts are on a page
and so which side of a pair comes first.

**Inside one dataset the fold stays,** because everyone who reads one of its measures reads the others, a
PII one aside. It also has to stay: a curator's merge refuses two base variants in one dataset, so a pair
split here could never be joined.

**A variant that is not PII is not filed under a PII base,** and takes a draft of its own name instead. A
reader of the variant would otherwise read the base's name on the metric. Where a rule keeps the named base out
and a copy stands in, a copy that is not PII goes first, so a PII one sorting earlier costs no merge.

**A metric a person worked on gathers a copy only under a name it already holds.** A measure of one
calculation joins it only when the metric holds a live base measure of that fingerprint and that name, in a
dataset that is on and not PII. Confirming a key (`pbmb metrics rename`, even to the same key) gathers nothing
of another name: a curator who sees only Sales could otherwise pull Finance's `Revenue` under `net_sales`, and
Finance's readers would read it. A generated key takes part only while it is that name, so a label a curator
changed brings no copies of the new label under the old key, and `zeta_2` from a measure called `Zeta 2` brings no
`Zeta`. What a person wrote still reaches a copy's reader,
which the threat model keeps as a residual risk. A curator's filing and a touched draft's name never move (repo
rule 9).

**A book drafted earlier follows at the next sync.** An untouched draft holding another dataset's other name
loses that measure to a new draft under its own name, its shifts with it, and is deleted if emptied. A measure
gone from Power BI leaves a draft nobody touched when no measure of its dataset filed in that draft has the draft's
name and is not PII, so a draft cannot keep a hidden name in front of its dataset's reader. A dataset removed earlier is
drafted once more to do so. Otherwise the measure stays, and comes back under its own variant. A draft a rule
dismissed keeps what it holds, as it does a live measure. A plain list of metrics hides it, while the metric, its
variant and the measures list still show its name, which the threat model keeps as a residual risk.

**A curator who empties an untouched draft deletes it in that change.** `visibleMetric` shows a metric with no
variant to everyone, so waiting for the next sync would put a key from a hidden dataset or a PII measure in front
of every reader. A merge already deletes in its own change. A metric a person worked on stays, because a person's
words are theirs to delete. A term link or a thread on an untouched draft does not count as work, and goes with it,
as it would at a sync: the link cascades, and the thread can no longer be reached.

**Turning a dataset on drafts it in a job of its own.** A dataset that is off is not drafted unless it changes, so
it can hold an older book's foreign name, or a name a PII rule has covered since it went off. Queueing a sync does
not work: an incremental sync within 30 minutes of the last one returns before it drafts, and a dataset's switch
should not start a scan. The job is the `sync` job with a `draft_dataset` argument, as the check job has `step`,
because a job name of its own changes a check constraint, and when this was decided a deployed database could
take no new migration. A job
for a dataset turned off again does nothing, as the switch is how an admin stops a crafted model.

**A generated key gives way to a curated alias.** `resolveMetric` finds a key before an alias, so a draft
called `revenue` would take the word from the metric a person gave the alias `Revenue`, and an agent asking
for it would get a different number with no warning. A new draft takes `revenue_2`, a `_2` does not take the
word back, and a draft already on the word gives it up at the next sync; until then the alias still loses.
Letting an alias win over a generated key at read time was rejected: the draft's own key would then open
another metric, so a curator could change the wrong one. A touched draft keeps its name, so there the key
still wins, as `resolveMetric` says.

**A word a key holds cannot be made an alias,** whether the curator can see that metric or not. Otherwise a
curator elsewhere could push a hidden draft off its key, and a reader of that draft would lose the name. The
refusal says the word is taken, as creating a metric with that key does. Postgres folds the word, as it does
for a reference, because JavaScript folds some letters otherwise. A new key cannot be a word another metric holds
as an alias either. A draft still yields to an alias older
than the refusal, or one that raced it.

`draft_name_security_test.ts` holds all of this on the sample tenant. Stops being right if a metric's row
stops being readable through any one variant, or if curators find too many drafts to merge by hand.

## A curator's answer costs what an agent decides on

**A likely merge is one entry for two measure names under two metrics, with a count of the datasets the caller may describe that hold its measure, and a metric's page names only the ten closest of the labels a failing `metric_not_the_same_as` counts.** Taken 2026-11-05. Agents read the queue, so its bytes are tokens. On the invented book in `test/large-book.ts`, ten drafts answered 585,755 bytes, and `suggested_merges` was 498,212 of them. One draft had 900 entries, 280 KB, which were 9 pairs of names, each 10 datasets times 10 datasets: the measures were paired all with all, so a widely held name multiplied by itself and the agent had the same thing to decide. The queue now answers 91,097 bytes, and `suggested_merges` is 3,554. At `limit=50` it went from 2,412,147 to 450,741. A metric's page carried every label that shares a word: `share_of_widgets_lq` answered 19,492 bytes, 17,959 of them this one check with its 868 labels. It now answers 1,824, and the check is 291. Any text in `not_the_same_as` passes the check, and the field says what a reader could mistake the metric for, so nobody writes a line for each of 868 labels. Labels rank by the content words they share, then the fewest they do not, then by name, so the list does not change with the order the rows come back. A curator who wants them all has them: the metric page's button and `pbmb metrics check` read `GET /metrics/{name}/checks`. An entry no longer carries measure ids. They were never variant ids, so an agent had to read the metric either way, and `apps/api/src/services/book/drafts.test.ts` acts on an entry with what it now holds. Both kinds of suggestion take this shape; the same-name kind keeps its limit of ten for a draft.

The entries from a word that a caller sees are the ones it could see before, because the measures were paired all with all: a pair the caller may describe exists exactly when each side has a measure it may describe. On the sample tenant the list and `hidden_suggested_merges` come out the same. The same-name kind offers the same pairs until its limit of ten binds. Past that the ten are chosen by metric id and no longer by the lowest measure id, and which side of a pair is `measure` can change, among metrics the caller may describe either way. Three things differ for access. `hidden_suggested_merges` now counts entries, the unit of the list beside it, so it says whether a hidden copy shares a spelling and a metric with a visible measure or another hidden copy, and no longer how many copies there are. It is never larger than it was. `dataset_count` counts only the datasets the caller may describe, unlike a draft's own `dataset_count`, which counts every dataset and names only some. And entries order by the measure's name and the metric, never a measure's id, because the security review built a tenant where a hidden copy with the lowest id moved an entry the caller could see. `curator_counts_security_test.ts` holds all three, and `reads_at_size.test.ts` holds the bytes.

What is left is the point of the queue: 68,765 of the 91,097 bytes are the variants, with their DAX. None of this changes how long the queue takes, because it runs the same statements. Stops being right in three ways. If a name is held by many metrics, because their DAX differs, its pairs by a word are a cross product of metrics, with no limit as the same-name kind has, and the invented book would not show it, since each of its names is held by one metric; a measure's partner in its own dataset is then the one to name first. And since the drafter now files many shifts under one metric, a widely held draft's variants can become what is large; the queue should then name the base variant per dataset and count the rest, as a metric's page does. And an agent that runs `pbmb metrics check` still pays for every label, so that command should print the ten closest if agents run it often.

## What a likely merge looks for is read once per name, and has a bound

**`suggestMerges` builds what it looks for from each distinct name and not from each measure, up to 2,000,000 characters for each asked metric, at most 25 entries from a word for each asked metric, and past 5,000 names it does not show the planner the array.** Found 2026-11-07, when the queue's wait grew with the drafts' names and most of it could not be explained. `addCrowdedDrafts` in `test/large-book.ts` seeds ten invented drafts of 15 names in 30 datasets each. On that book at `limit=10`, for a caller without `pii_reader`, the queue took 695 ms, and 264 ms of that was Postgres. A CPU profile put 375 ms in one synchronous function, `suggestMerges`, which built 36 hints times 8 word positions for all 4,500 measure rows to arrive at 46,650 distinct strings. Reading each name once took that to almost nothing. `EXPLAIN ANALYZE` of the read that sends those strings showed 63 ms of planning and 22 ms of execution, because the planner prices `= any` on a constant array one element at a time, against the most common values of the index. Reading through `unnest` removes the planning. The queue now takes about 300 ms for that caller and about 200 ms, down from 612 ms, for one with `pii_reader`, and the statements Postgres runs are most of that. These are one laptop's numbers, so production's share of each part still has to be measured after this ships.

Three details hold that up. Under 5,000 strings the read stays `= any`, because there the planner's own choice is the index, and `reads_at_size.test.ts` holds it; the `unnest` form chooses a sequential scan that would fold every measure's name. The `unnest` form folds each name once under `offset 0`: without it, on a table with no statistics, a nested loop folded each name once per string, and one statement took 21 seconds where it now takes 275 ms. And the bound is filled by the names the caller may describe first, so hidden measures cannot use it up: `suggestions_bound_security_test.ts` holds that a pair the caller could see stays, and `queue_at_size.test.ts` holds the size. What reaches a caller is decided as before, by `allowed` and `unlessPii`, and no hidden name becomes part of an entry.

The entries a word produces have a limit of 25 for each asked metric (`WORD_ENTRY_LIMIT`), in the order the names sort, and the loop stops once every asked metric is at it on both counts. Two metrics with thousands of spellings a side used to pair all with all, so the loop that makes entries could use a lot of memory. Ten, like the same-name kind's, would have changed an ordinary book, because the sample tenant's `net_sales` holds 12 such entries and `suggestions.test.ts` expects all of them. A pair with a side the caller may not describe is counted apart, with its own 25, so a hidden name cannot push a visible entry out. The strings the read sends have limits, counted from the strings built and not from arithmetic on the names: 2,000,000 characters for each asked metric, and 1,000,000 strings and 96,000,000 characters for all of them together. A first version estimated, and its estimate cut an ordinary page: about 300 names were admitted, so `limit=50` at 15 names a draft lost later-sorting names whatever their queue rank. A full page of that size builds about 430,000 strings of 69,000,000 characters, which `suggestions.test.ts` holds as not cut. A name's strings are still bounded by an estimate before they are built, only so that one name of megabytes cannot build more than a limit before it is counted. Names are taken in the caller's reach first, so measures out of it cannot fill a limit before a measure in it: the order is `bool_or((policy) is true)`, because a policy over a nullable column (`sensitivity_label`, `endorsement`) gives NULL for a dataset without one, and NULL sorts first under `desc`. When a name the caller may describe is left out, its draft carries `suggested_merges_truncated: true`; a name out of reach that is left out sets nothing, so the flag says nothing of hidden names. Each limit has a test in `suggestions.test.ts` built so that only that limit can stop it (rows, total characters, characters for one metric), checked by taking the limit out and seeing that test fail; the order, the flag and the counting apart are in `suggestions_bound_security_test.ts`. The loop that makes entries stopping early changes no answer, so no test can see it.

Accepted: past a limit, a hidden name's strings can bring back a visible pair. The read of measures matches one set of strings, and past a limit that set is built from the names that fit, hidden ones included once the visible ones are in. A hidden name whose strings equal those of a visible pair's name then makes that pair appear, which it would not otherwise, so a person who publishes models and can also read the queue learns one bit for each crafted probe: that some name out of their reach produced that string. No name, id or count leaves, and the pair shown is one the caller may describe on both sides. Closing it would mean building the set from visible names only and finding hidden names in a second pass, which doubles the reads on the queue for a one-bit signal that needs both a crafted hidden model and the curator's reach to the draft. Stops being right if a deployment has someone who writes measure names in datasets a curator cannot see and also reads that curator's queue.

One thing was not done. The queue also still names every variant, not only the base ones, although in the crowded book they are almost all of its answer. `pbmb drafts next` prints each variant's shift, `skills/curate_metrics_book/SKILL.md` and the curators' guide work from those variants' ids, and `drafts.test.ts` finds a draft by a shifted variant. The connector and the SPA do not read this route.

Stops being right if a draft ordinarily holds more than about a hundred long names, when the bound starts to lose suggestions; if the mirror grows so large that folding every measure costs more than planning 5,000 strings; or if a draft ordinarily has more than 25 entries from a word, when the limit starts to lose suggestions a curator wants.

## The catalog asks for pages

**Each list in the catalog asks for 50 metrics at a time, and its counts come from the api, never from counting a list.** A real tenant's first sync left thousands of drafts, and the catalog read them all before it drew anything: 45 requests in a row, on every page of the catalog. `metric_count` and the summary's `not_filed` now answer the counts, and the tree asks for a category's metrics only once it is opened. The Metrics home asks for one page per category with metrics of its own, and draws each list as it arrives: the summary only adds a number, and if it fails the lists stay. Not filed is a view of `/catalog` (`?view=not-filed`) and not a path of its own, because a new path would be one more entry on the public list for no gain. `apps/web/src/catalog/categories/metric-list.test.tsx` and `home.test.tsx` beside it hold it, and `apps/web/e2e/catalog-metrics.spec.ts` on the real api. Stops being right if a book has so many categories that one request each is what makes the home slow.

## An icon is presentation: it is not curation

**A metric, category, term, workspace or dataset can carry an icon (`emoji:<one emoji>` or
`glyph:<name>:<color>`). Setting or clearing one writes a `book_change` row with action `icon` and
the icon before and after, and changes nothing else: the trust state and `touched_at` stay as they
were, and the sync never writes the column.** A curator's choice of look says nothing about what a
metric means, so it must not return a verified metric to draft or make an untouched draft look
worked on, which would stop the sync from renaming or merging it. The record is kept so the history
shows who chose it. Only a curator may set one, and only on an element the caller may reach: a
dataset or workspace as `docs` reaches it, a metric as the lists show it. The shape is held twice,
by `checkIcon` in `icons.ts` (with a sentence saying what to change) and by a CHECK on each column
(`emoji:` of 1 to 8 characters, or a `glyph:` with a name from `icon-glyphs.ts` and one of eight
colors), so a write that skips the service is still refused. `icons.test.ts` holds the trust state
and the record, `book.test.ts` the CHECKs, `icons_security_test.ts` the reach.

Stops being right if an icon ever carries meaning (a status that readers act on): it would then be
curation, and would need the trust rules. It also stops if the glyph list changes: the CHECK holds
the names at migration time, so a name removed from `icon-glyphs.ts` needs a migration.

## Questions are off by default

**Questions are off by default, and the gate lives in the threads service.** Taken 2026-11-14.
The `questions.enabled` setting lets an admin choose whether people and agents ask, reply and
accept answers. Stored threads remain when it is off. A route-only gate would leave other callers
open: the CLI, MCP and REST all use the same service. Catalog answers omit question fields while
off. The CLI behavior is checked in `apps/cli/tests/commands/test_questions_setting.py`;
the service gate is specified in `docs/specs/2026-11-14-questions-setting.md`, section 2.

Stops being right if questions become required for every deployment, or a new caller can reach
threads without the service. That caller must use the same gate before it reads or writes a thread.
