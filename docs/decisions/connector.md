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
