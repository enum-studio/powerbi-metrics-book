# Learning from use: requests and the search log

The decisions behind `docs/specs/2026-11-11-requests-and-usage-report.md`,
taken with Martin on 2026-11-11.

## The server logs searches and the agent states the request

**Searches are logged by the server, and the agent records each question
it was asked with `record_request`. Neither alone is enough.**

Why: the MCP server keeps no session, so the server alone cannot tell
which searches and queries served one question, and it cannot know what
the person wanted or whether they got it. A search with no hits is a
strong sign of a gap, though, and it costs the agent nothing. The stated
record carries what only the agent knows: the question in the person's
words, the outcome, and what was missing. An agent that skips
`record_request` still leaves its searches and queries behind.

When it stops being right: if agents record requests so rarely that the
report's request lists stay empty on a busy deployment, the passive side
has to carry more, for example a short `request` argument on `search` and
`execute_dax`. If MCP clients start sending a session id the server can
trust, calls could be grouped without the agent's help.

## The agent classifies the gap; the server only counts

**A request's gaps are chosen by the agent from a fixed list
(`GAP_KINDS`), and the report counts them. The server never reads the
text to classify it.**

Why: the product has no AI inside it. A fixed list gives the report
something to group by without a model on the server, and the person's
agent, which saw the whole conversation, is in the best place to say what
went wrong. The free text in `missing` is for the curator's agent to read.

When it stops being right: when `other` holds most gaps in the reports of
real deployments. Then the list is missing a kind, and the fix is a new
entry, read from the `missing` texts filed under `other`.

## Browser searches are not logged

**`search_log` takes searches from the connector, the CLI and the REST
API. A search from the browser writes no row.**

Why: the web app searches while a person types, from the second
character, so one question would leave a row per prefix and fill the
"no hits" list with half-words. Agents send whole questions.

When it stops being right: if the web app gains a search that runs only
on Enter, or curators want the browser's searches too. Then log the
browser's on submit, never per keystroke.

## A person and the curators read requests

**A person reads their own requests and searches; curators and admins read
everyone's, with names. Only the owner and admins delete one.**

Why: a question is personal data, and may name a customer or a colleague,
so it is not readable by everyone signed in as the query log is. Curators
need the names, because the useful next step is often to ask the person
what they meant. A curator who could delete records could hide what the
report shows, so deletion stays with the owner and admins. The owner is
compared by kind and id, as threads and results are, because a service
account's name could equal a person's id. Tested by
`apps/api/src/services/usage/usage_access_security_test.ts` and
`access/tests/usage_test.yaml`.

When it stops being right: if a company's works council or data
protection officer wants curators to see requests without names. Then a
deployment policy can narrow `request:read`, and the report needs a
pseudonym in place of the principal.

## Kept 180 days, at most 365

**Requests and searches are kept 180 days by default
(`usage.retention_days`), and never more than 365. A daily worker job
deletes older rows.**

Why: half a year shows the patterns a curator acts on, across two
reporting quarters, while keeping personal data no longer than the
purpose needs. The cap of 365 lets a company see a full year, such as
year-end and budget questions, and no more.

When it stops being right: when a company needs a longer view. Then the
report should keep counts per month past the retention, never the text.

## No redaction of the text

**The server does not redact the question or `missing`. The tool's
instructions, the readers, the retention, deletion and a switch to turn
capture off protect the text instead.**

Why: without a model the server cannot find personal data in free text. A
list of patterns would miss most names and would mangle metric names and
DAX that look like them. Telling the agent at the point of writing (never
copy values from a result) stops most of it where it starts.

When it stops being right: if a review of real records finds personal data
in a large share of them. Then the first fix is the tool's description and
the skill; a redaction step on the server would mean a model in the
system, which is a product decision for Martin.

## The query log is left as it is

**This work does not change `query_log`. The report reads it as it is: an
empty `metric_ids` means a query used no metric of the book.**

Why: the log already holds the DAX, the purpose, and the measures and
metrics a query used, which is enough to find DAX written by hand. Changing
it would add a migration to a security-sensitive table for no new signal.
Its own retention is a separate task, because its `purpose` is personal
data kept forever today.

When it stops being right: when the report needs something of a query that
the log does not hold, such as the columns a query aggregates by hand.
Then add it to the log, and give the log a retention in the same change.

## Corrections from building

**The spec follows the implemented policy files, scheduler and visibility
checks.**

Checked against the integration branch on 2026-11-11:

- Cerbos needs one resource policy per file. The single `usage.yaml`
  design became `access/policies/request.yaml`, `search_log.yaml` and
  `usage_report.yaml`. The spec already names these three files.
- The expiry job is `expire_usage`, registered in
  `apps/api/src/services/usage/expire.ts` and scheduled daily at 04:15 in
  `apps/api/src/worker.ts`. The spec now distinguishes the handler from
  the scheduler.
- `Access` gained `readableRequests` and `readableSearchLog`, and
  `ResourceKind` gained `request`, `search_log` and `usage_report`
  (`apps/api/src/context.ts`). The spec now names these interfaces.
- `apps/api/src/services/usage/report.ts` also hides measures ruled PII
  by an admin and filters flagged elements for callers without
  `pii_reader`. `hidden` counts only query rows and request elements cut
  by dataset describe, not exclusions by PII. The spec previously counted
  every undescribable request element there; it now states that distinction.
- `list_requests` and `get_request` filter `elements` to those the reader
  may describe, including PII checks, in
  `apps/api/src/services/usage/requests.ts`. The spec now says so; this
  does not redact the question or `missing`.
- Request text uses the thread service's `checkedText`. The spec now gives
  the exact length refusal: "The question is longer than 2000 characters."

When it stops being right: when those interfaces, policies, schedule or
visibility checks change. The usage service tests, access security tests
and policy tests named in the spec check the behavior; this note and the
spec change with it.

## A request's text is not filtered by dataset

**Curators and admins read a request's question and `missing` whatever
datasets its elements name. Only the elements, and the queries, measures
and datasets the report shows, are filtered by what the reader may
describe.**

Why: Martin decided on 2026-11-11 that curators read everyone's requests,
with names, because the next step is often to ask the person what they
meant. The text is the person's own words, not metadata Power BI holds, so
`access.metadata_visibility` does not govern it. Hiding a request because
its elements sit in a dataset the curator cannot describe would also hide
the gap a curator most needs to see: a question no curator can answer
alone. The security review of 2026-11-11 raised it as a medium finding;
it is accepted here, and the comment in `report.ts` says so.

When it stops being right: if a company runs `metadata_visibility:
powerbi` with curators who must not learn what other teams ask about. A
deployment policy can narrow `request:read`; the product would then need
to hide a request whose every element the reader may not describe, and
count it in `hidden`.

**Open.** Recording has a per-minute limit (30 a minute for
`record_request`, 60 for search) and no daily cap, so one looping token
could write tens of thousands of rows a day, each kept for the retention
period. A daily cap per principal is a product decision for Martin.
