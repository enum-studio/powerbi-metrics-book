# The connector's answers

Taken on 2026-11-05, after using the connector as an agent would on a real tenant's book.

## A list ends on a whole row with its cursor

**A page too long for one answer is asked for again at the size that fits, so it ends on a whole row
with a `next_cursor` that starts right after it. A list with no cursor is kept to its whole rows.**
Cutting the serialised text at 16 KiB, as the connector first did, left broken JSON and took the
cursor with it, because the cursor comes last. Every default list call on a real book hit this: the
default limit of 100 cannot fit, since a metric row is about 300 bytes and a measure row about 600. An
agent had no way to reach the second page, whatever the message told it to do.

Only a service can make a cursor from a row, so the rule is the second query rather than a cursor
made in `apps/api/src/mcp/`. It goes through the same service and the same access checks as the first.
`defineTool` applies it to any tool that takes both a `cursor` and a `limit`; `result.test.ts` names
those tools. A caller cannot see one run twice: the only write among them is the mirror refresh in
`list_measures`, which a fresh model and its rate limit keep from repeating. The two queries share no
snapshot, so a page that still does not fit is cut with no cursor rather than one that skips rows.
`search` and the lists with no limit are never asked again: a search counts against its rate limit
and can pay for an embedding.

The default limit is 25 and the most is 100, so a page rarely needs the second query and a batch of
20 calls cannot run 40 lists of 500 rows. The limit of the REST API is not changed: it has no 16 KiB
bound. A cursor can be 2,000 characters, because a list orders by up to three names and a name has no
bound of its own; a longer one is left out of a cut answer's note, and the cut and its note together
stay within 16 KiB.

Stops being right if a list becomes slow enough that the second query matters, or if the answer's
bound changes from 16 KiB. A list that writes as it reads could not take this rule.

## `get_metric` answers with the measures first

**`get_metric` answers with the trust state, the measures and the checks ahead of any text of open
length, and shows at most 10 of the labels a check names.** The check that compares labels can name
thousands of metrics when a label holds a common word. It came before
`base_variants`, so the answer was cut before it reached a single `measure_reference`. In a random
sample of 20 metrics on a real book, all 20 lost every measure this way, on the tool an agent is told to
call before writing DAX. The curator's screens and the CLI still read the whole list from the service;
the bound is the connector's, so the shortening is too. The check's message still counts them all.
A definition can be 20,000 characters, and anyone who can see a metric can add up to 10 accepted
answers of 2,000, so either could otherwise push the measures or the checks out of the answer.

A cut can now take only that text, unless the measures themselves overflow: a base variant is about 500
bytes, so that takes about 30 datasets on one metric. Nothing bounds that number, and `list_variants`
pages them. Stops being right if a metric's base variants commonly reach that many.

## A list row is an anchor

Taken on 2026-11-14.

**The connector answers a list with anchors: `apps/api/src/mcp/anchors.ts` names the fields each kind
of row keeps, in order, and the most characters each text field may take, and leaves out nulls,
empties and flags at their default. The REST API, the web app and the CLI keep the service's shapes.**
On a production tenant with 46 datasets and about 1,300 metrics, a metric row had grown to about 750
bytes, a variant row to 650 and a search hit to 800, against about 300 for a metric row on
2026-11-05. Most of it was nulls, empty arrays, default flags and whole parent objects repeated on
every row: a 230-byte category with its description on each metric. Each service added fields for its
own screen, and nothing held the connector's rows to a size, so an agent paid for them on every page.

A field is listed to be kept, never to be dropped, so a field a service adds later stays out of the
connector until someone adds it to an anchor. A text field over its limit is cut on a word end by
`excerpt` (`apps/api/src/services/text.ts`) and flagged with `<field>_truncated`; the get tool
for that kind answers it whole. A parent is a name or a path, and a parent the call filtered on is
left out. The bound is the connector's, so the shaping is too: the services, the REST API and the
generated web types answer as before, gaining only optional fields.

`anchors.test.ts` holds each kind of row to a target in bytes, measured on a fixed row: each limited
text field at its limit in ASCII, every flag set, ids as UUIDs and names at 40 characters. On that row
a metric is 650 bytes, a variant 700 and a search hit 750. A real row is smaller, because most fields
are empty and most flags at their default: a base variant's row carries only its id, dataset, measure
and `measure_reference`. The test fails when a row's size moves, so a field cannot come back
unnoticed. A target is not a cut. Names are never shortened, text in a wider script takes more bytes,
and the 16 KiB bound of `apps/api/src/mcp/result.ts` stays the limit on an answer.

Stops being right if an agent commonly needs a field an anchor leaves out to choose its next call,
which shows as a get call after nearly every list call in the query log and the usage report, or if
the answer's bound changes from 16 KiB.
