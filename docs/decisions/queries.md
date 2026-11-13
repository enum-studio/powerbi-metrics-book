# Queries and results

## CSV cells that look like formulas

**A string cell or a header name that starts with `=`, `+`, `-`, `@`, a
tab or a carriage return is written with a leading `'` and quoted:
`"'=HYPERLINK(...)"`.**

Why: a result holds whatever the model's text columns hold, and a person
opens the CSV link in Excel, Numbers or Google Sheets. Those programs read
a cell that starts with one of these characters as a formula, so a value
such as `=HYPERLINK("https://...")` in a customer name runs when the file
opens (OWASP, "CSV Injection"). The apostrophe makes the spreadsheet show
the text as written. Numbers and booleans are written as JSON writes them,
so `-12.5` stays a number. Decided 2026-10-26 in the security review of
the query service; `apps/api/src/services/queries/csv.test.ts` checks every
character.

The cost: a program that reads the CSV as data, such as pandas'
`read_csv` or an agent parsing it, sees the `'` as part of the value, so
`'-1` arrives as the text `'-1`, not as `-1`. Only text cells change.
Numbers keep their sign. A reader that needs the exact text strips one
leading `'` where the next character is one of the six.

When it stops being right: if agents read the CSV more often than people
open it, and the spreadsheets people use stop running formulas from CSV
files, offer a raw download beside this one rather than dropping the
apostrophe for everyone.

## The query log's search filters in SQL

**A search of the log turns Cerbos's plan for `query_log:read` into a
condition of its SQL, as a list of datasets does with `dataset:describe`.
`get_query` still asks Cerbos about the one entry.**

Why: the search used to read a page and then ask about each row, and made
`next_cursor` from the last row read. Under a narrowed policy that cursor
held a hidden entry's id and time, and with `limit: 1` and `text` it said
whether a hidden entry's DAX held a word. Reading on until a page is full
would close that too, but one request could then read the whole log and ask
Cerbos about every row, and any cap on that reading would bring back a
cursor past hidden rows. In SQL, a hidden entry is never read. Decided
2026-11-05; `log_paging_security_test` checks it on a real policy.

The cost: a `query_log` rule may use only what `plan.ts` translates:
`principal_kind`, `principal_id` and the id, with `and`, `or`, `not`, `==`
and `in`. Any other rule fails every search of the log loudly, while
`get_query` keeps working. A deployment that wrote `!=` rewrites it as
`!(a == b)`.

When it stops being right: if a deployment needs a `query_log` rule over
something that is no column of the log, such as what the DAX says, teach
`plan.ts` that attribute, or send it in both places.

## The row budget under parallel queries

**Before Power BI is called, each query holds 100,000 rows, Power BI's
most for one query, against its principal's daily budget in
`query_reservation`, and gives them back when its log row is written. A
principal has at most 4 queries in flight.**

Why: the budget counts rows from the query log, which is written after a
query ends. Without the hold, ten queries started at once each see the
same unspent budget and all run. A lock per principal orders the holds,
and a query is refused when the rows returned in the last 24 hours plus
those held reach the budget. So a principal passes the budget by at most
one query's rows, as when queries run one after another. A hold expires
after 10 minutes, longer than the 300 seconds a query may run, so an api
that crashes mid-query frees it. `apps/api/src/services/queries/execute.test.ts`
("refuses queries past the daily row budget") runs ten at once against
the mock and counts how many reach Power BI.

When it stops being right: when Power BI raises its 100,000-row limit, or
the query timeout passes 10 minutes.

## The query log is readable by everyone signed in

**Every signed-in person can search the query log (DAX and purpose, never results), so agents reuse
working DAX.** Taken 2026-10-25 (review item 6). The other default was "your own queries; curators
see all". Power BI's error sentence is shown only to the query's own principal, because it can
quote a cell value. A refused query's entry keeps up to 100 KB of its input, so the log shows what
was refused. Stops being right if the log is found to teach an agent DAX over a dataset its person
cannot reach: under `metadata_visibility: powerbi` the log shows dataset names and DAX of datasets
the reader cannot reach, and the fix is one Cerbos rule or a filter to describable datasets.

## Results are kept 24 hours, in Postgres

**A result is kept 24 hours by default and 72 at most, in Postgres, in pages, read by page or downloaded as a CSV
through a signed link; only the principal who ran the query reads it.** Taken 2026-10-25 (review
item 9). Big results stay out of the agent's context and out of any other store. A link download is
audited as `detail.by = "csv_link"` with the client address, never as the owner's own request, and
the owner is re-checked on the link path. Link and credential downloads share one per-owner budget.
Deleting a service account deletes its results, so a new account with the same name inherits
nothing. Previews and pages stay within 16 KiB even for one huge row. Stops being right if a
company needs results kept longer than 72 hours; the setting is `results.ttl_hours`.

**Changed 2026-10-27: the default is 24 hours, the cap is 72, and a backup holds no result rows.**
Martin decided that results hold company data, so the product must not keep them long: hours, at
most a few days. The cap is in the setting's schema, so a saved value above 72 is refused. The VM
backup dumps `query_result` and `query_result_page` without rows; the query log keeps the DAX, so
after a restore an agent runs the query again. The CSV link stays at 15 minutes. Platform backups
(Railway, Azure) keep everything, so results in them are at most 72 hours old when taken. Stops
being right if a company needs results for longer than 72 hours or a restore that keeps them.

## Limits on what one caller can ask

**A spent daily row budget answers `rate_limited` with when it frees up, and so does a fifth query
in flight. `purpose` is capped at 2,000 characters and refuses NUL. A service account is refused on
a row-level-security dataset by the api itself, before any token is used.** Power BI refuses a
service principal on such a dataset, and the api's answer is the same sentence with no call out.
Stops being right if Power BI's limits change; see the row budget above.
