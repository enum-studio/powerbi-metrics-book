# Search

Taken in the spec of 2026-10-25 or during the build (2026-10-25 to 2026-10-27), as each says.

## OpenAI or Gemini, the operator's own key, 1,536 dimensions

**Embeddings come from OpenAI (`text-embedding-3-large`) or Gemini (`gemini-embedding-2`), with the
operator's own key, at 1,536 dimensions; with `search.provider: none`, search runs on words alone
and every answer says so.** As Metrics Book, so the two can share an embedder and a pgvector
column. Only metadata leaves the stack: names, descriptions, display folders and term values, never
DAX, a result or a thread's text. A query vector is compared only with vectors of its own model.
Stops being right when the model names change or a provider stops offering 1,536 dimensions.
`search.base_url` and the Power BI hosts are set only in the environment: see `security.md`.

## The vector side uses HNSW with an iterative scan

**The vector side uses the HNSW index with pgvector's iterative scan, with the permission filter in
the same SQL query.** The first build was a filtered brute-force scan, about 300 MB read per search
at 50,000 documents, found in the search review. A search also has input bounds, a per-principal
rate limit and a statement timeout. Stops being right if the permission filter becomes so selective
that the iterative scan misses results. A walk can also miss rows with no filter at all: see the
next section.

## A walk returns only the rows the graph reaches

**Open: whether a real book's graph can keep a query from rows it should find. Until that is
measured, search has no exact scan behind the HNSW walk.** HNSW does not promise that a walk reaches
every row. A walk runs on no clock, so a busy machine cannot change what it returns.

What it looks like, measured on 2026-11-05 on Postgres 18.6 and pgvector 0.8.7. Take 300 vectors
0.001 apart along one axis, half of an index of about 600 rows. In 14 of 280 freshly built graphs, a
walk from a query among them found almost nothing else. `search`, for a person who may see 3 rows
elsewhere, found none of the 3 (in one graph, 1 of them). Its answer was `search_mode` hybrid with
no note, the same as a filter that matches nothing, a caller who can see nothing, or no vectors for
the current model. A failed query embedding answers differently: `words_only`, with its note.

The same graphs were not cut for everyone. In the 9 cut graphs where it was tried, a walk from
another document reached all 608 rows. An `EXPLAIN` showed the index in all 120 rounds of that run,
and raising `hnsw.scan_mem_multiplier` a thousandfold changed nothing, so neither a sort nor the
memory stop explains this.

Each row below is 300 vectors, half of an index of about 600 rows, in a graph built fresh for each
count, walked with no filter from the query they surround:

| The 300 vectors | Graphs | What the walk missed |
|---|---|---|
| 0.001 apart along one axis each | 280 | In 14 graphs, nearly every other row |
| 0.03 to 0.2 apart along one axis each | 120 | In every graph, 118 to 210 of the 300 |
| Identical | 40 | Nothing |
| Apart in every dimension, cosine distance about 0.04 | 200 | Nothing |
| Apart in every dimension, cosine distance about 0.000001 | 100 | Nothing |
| Apart in every dimension, cosine distance 0.0009 to 0.25 | 100 | Nothing |

The first, fourth and fifth rows are on the sample tenant, the others on a plain table. Why one axis
loses rows and every dimension does not was not worked out: a move of 0.2 along one axis and the
fourth row put pairs about as far apart on average, and only the first loses rows. These vectors are
seeded, not a provider's, so a real book is unmeasured. `search_visibility_security_test.ts` seeds
in every dimension, so no test exercises a cut query any more.

Deciding this needs a person with database access, since no agent holds that credential, to measure
a large book. Set `enable_seqscan = off`, `hnsw.iterative_scan = relaxed_order`, and
`hnsw.max_scan_tuples` and `hnsw.scan_mem_multiplier` high enough not to stop the walk. Confirm the
index with `EXPLAIN`. For many documents, not one, walk from the document's own vector with
`order by embedding <=> $1` and no filter, and compare the rows with the rows that hold a vector,
starting with documents that have near-duplicates. If a walk misses rows, the meaning side needs an
exact scan when the walk comes back short of its pool. The HNSW test must change with it: that scan
would fill the page with the walk turned off, and the test's last check runs its own query, so the
test would keep passing and nothing would flag it.

## A failed query embedding falls back to words

**When the embedding of a query fails for any cause (a timeout included), search answers from words
alone and says so. A query embed never waits on a provider's `Retry-After`; a document embed does.**
A provider outage should not take search down. `embedder_security_test.ts` checks both waits, and
was changed in the search branch to run its `Retry-After` test on document embeds. Stops being right
if a company wants search to fail loudly when meaning is unavailable.

## What the provider sees, and what a person finds

**A metric's search text does not list its variants' measure names, and a term's holds only its own
words. A variant in a personal workspace leaves the workspace's name (its owner's) out of the text
sent to the provider.** A person who sees a metric through one dataset could otherwise find measure
names from a dataset they cannot see. Terms are visible to everyone signed in, so
`search_visibility_security_test.ts` expects an outsider to find a term backed by a Sales column.
An app filter answers a hidden app like a missing one, so a filter never says whether it exists.
Stops being right if terms stop being visible to everyone.

## Embedding is triggered by changes and bounded

**Every `book_change` queues one `embed` request; the sync's run rebuilds everything and compares
hashes. `search_text` is capped at 8,000 UTF-8 bytes. A text is held to be at fault only after a
fixed probe sentence succeeds in the same run; refused batches split in halves, and a run has a
10-minute budget, after which it queues its successor.** The spec re-embeds "on the next sync",
which would leave a curated description unsearchable for up to an hour. The probe stops one bad
text from marking a whole batch. Known gap: when a full run ends on its budget while a changes-only
request is queued, the rest waits for the next sync. Stops being right if a provider's batch limits
change.

## The mock embeds by concept

**The mock's embeddings come from a small deterministic concept table (revenue is near sales,
orders near purchases), with no model and no network.** A hash of the whole text could not test
"search by meaning". The end-to-end test finds a metric by a phrase that shares a concept but no
word. Stops being right if the table grows past what a reader can check by eye.

## The last word is a prefix, a typo is found by trigrams, and trust lifts a hit a little

**Search blends three rankings by reciprocal rank fusion (`RRF_K` 60): meaning, words, and
typo-tolerant names. The words side ANDs every word of the query and reads the last as a prefix
when it has 2 characters or more, so `net sal` finds `net sales`. The typo side lists documents whose
name or label has a pg_trgm similarity of 0.3 or more to the query. A human verified hit gains 0.0025
and an agent verified one 0.0015, added to the fused score.** A prefix lets a
search start before the last word is finished. Each word is quoted
before it reaches `to_tsquery`, so no operator typed in the box reaches its syntax; a query with no
word makes no words side. Trigrams catch a name typed with a letter wrong, which neither meaning nor
whole words do, and they use the indexes on `name` and `label`. 0.3 is pg_trgm's own default, kept
because we have not measured a better one. Hits as alike share a rank, so a metric and its variants
with one label tie. With 60 as the constant, one rank near the top is worth about 0.00025, so 0.0015
moves a hit up about 6 ranks and 0.0025 about 10. That is enough to put a verified metric above
drafts the sync made with the same words, and too little to beat an exact match, whose 1 stays above
any lift. The figures come from that arithmetic and from `query.test.ts` ("lifts an agent verified
metric past the drafts ranked above it by words"), not from a study of what people click.

Stops being right if `RRF_K` or a pool changes (the lifts must be worked out again), if a company
finds 0.3 lets in too many names or lets a real typo go (then it becomes a setting), or if a
Postgres text search configuration other than `simple` is used (a prefix would stem differently).
The words and typo sides keep their pool of each kind, not of all kinds together: with one shared
pool, a word every column carries filled it with columns, and the metrics it also matched dropped out
of reach. `counts` is taken from every words and typo match before either is cut to its pool, plus
the exact matches and the meaning pool, so it is the true count: cut at the pool, production's "gmv"
showed "Measures (100)". Both sides already read every match to rank it, so the count adds no scan.
Revisit if a large tenant's search nears the statement timeout. Among exact
hits the sections' order (metric, measure, term, category, dataset, table, column) comes before the
fused score, so a metric leads a measure of its own name; elsewhere the order only breaks a tie.
`query.test.ts` holds these ("counts a kind in full when another kind fills the words pool",
"counts every match of a kind, past the pool", "leads
with the metric when a metric and a measure are both exact").

A hit's category path stops at a cycle in the data, so a bad row cannot run a search to its 5 s
timeout. The curation service refuses a cycle; the guard is for one that gets in another way, and
`query.test.ts` ("stops a category's path at a cycle written into the data") holds it.
