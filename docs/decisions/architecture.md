# Architecture

Decisions here were taken in the spec of 2026-10-25 or during the build that followed (2026-10-25
to 2026-10-27), as each says. Martin took the defaults in "For Martin's review" when he approved the spec.

## The names

**The product is "Power BI Metrics Book", the repository `enum-studio/powerbi-metrics-book`, the
image `ghcr.io/enum-studio/powerbi-metrics-book`, the PyPI package `powerbi-metrics-book`, and the
command `pbmb`.** Taken 2026-10-25 from Martin's brief. Metrics Book's command is `mb`; `pbmb` keeps
the family and never collides with it. Stops being
right if Metrics Book and this product merge into one, or if either name is taken on PyPI before the
first release.

## One organisation and one Power BI tenant per deployment

**A deployment serves one organisation and one tenant, self-hosted.** As Metrics Book. Multi-tenancy
would put a tenant id on every table and every Cerbos request, and the per-container secrets and
the audit log would need a second boundary. Stops being right when someone needs to host several
companies in one stack; that is a new design, not a flag.

The database holds its tenant: the setup's first admin writes the tenant id and whether it is the
mock into `deployment_tenant`, and the api and the worker refuse to start against another tenant
or the other side of the mock. So moving to another tenant, from the sample to a company's own
Power BI for one, is a new database, never an edit of the settings. Stops being right under the
same condition: when one stack hosts several companies.

## One language on the server, Python for the CLI

**All server code is TypeScript (Hono on Node 24), and the api and the worker are two commands of
one image. The CLI is Python 3.13 with Typer.** Metrics Book's jobs are Python because dlt and dbt
are. Here the jobs are Power BI REST calls and embeddings, so one language, one Power BI client and
one embedder serve both. The CLI stays Python, Martin's home language, so the remote commands, the
device-flow login and the credentials file can become one library both CLIs use. Stops being right
if the worker needs a Python-only library.

## The image mirrors the repository's layout

**The image puts the code under `/app` in the repository's own layout: `/app/apps/api/dist`,
`/app/apps/api/src/db/sql`, `/app/access/policies`, `/app/conventions/presets`.** A path a module
computes relative to itself then works from source and from the image. The image sets
`NODE_ENV=production`; the dev and test overlays override it, and the api refuses to start without
it. Stops being right if the image stops carrying the SQL files or the presets.

## The guarded fetcher

**Every outbound call goes through one fetcher, built on `undici` 8.12.3 (pinned) for DNS-pinned
connections.** A host that is looked up once and connected to again can answer differently the
second time. The fixed-host profile (Microsoft identity, Power BI, Graph, the embedding provider)
allows private addresses, because Power BI Private Link and private endpoints resolve to them; its
controls are https, the configured-origin allowlist, no redirects, and size and time limits. Only
`fetchUntrusted`, for a URL a client chose (a client metadata document, an OpenID issuer), refuses
private addresses. Any unexpected error answers one fixed sentence, because a header error from
Node once carried a stored key whole into the log. Stops being right if a fixed host's URL ever
becomes something a client can choose.

## The dev stack on the mock

**`pnpm dev:up` publishes only the api's port and the mock's (api port + 1); Postgres stays on the
internal network, and the mock sits on `egress` only.** The mock is a stand-in for the internet, so
it must not sit beside Postgres. `sample_data` is true when `powerbi.authority`'s host is
`localhost`, `*.localhost` or a loopback address, which only the mock can be: outside development
the authority must be https to Microsoft's hosts. `pnpm dev:up` also writes `.mcp.json` and
`.cursor/mcp.json` with the checkout's port, both git-ignored, so the plugin carries no MCP server
and a committed placeholder cannot make Claude Code mark the server invalid. Codex's block in
`.codex/config.toml` stays committed and commented out, because that file holds the permission
profile. Stops being right if a stack needs a second published port, or Claude Code accepts a
placeholder in the URL.

## JIT is off

**The database runs with JIT off, set by `apps/api/src/db/sql/database.sql` on every start of the
api.** Postgres compiles a query once its estimated cost passes 100,000, and that estimate can be
far from what the query does. On Postgres 18, seeded with about 9,000 metrics and 11,000 measures,
the book summary's count is estimated at 232,545 and runs in about 35 ms with hash lookups, and JIT
adds about 25 ms to compile it. The same filter with `limit 50` is estimated at 1,761 and is never
compiled. A deployed stack with a book that size, with Postgres limited to one CPU, answered the
summary in 1.2 to 1.7 seconds and the first call on a new connection in about 3, while a list took
about 0.3. With JIT off, and nothing else changed on the request's path, the same stack answered it
in 0.26 to 0.36 seconds and the first call in about 0.5 (2026-11-04). So compiling costs far more on
one CPU than a laptop shows, though that deployment's plan was not read, because no agent holds a
credential for its database. No query here is known to compute for seconds, so JIT has nothing known
to pay back. It is a setting of the database rather than of the server so that it reaches a running deployment with
no restart of Postgres, and a managed Postgres where the migrator owns the database. Where it does
not, the api does not start, as the migrations already would not. `apps/api/src/db/migrate.test.ts`
holds it. Stops being right if the stack gains a query that computes for seconds; that query then
sets `set local jit = on` in its own transaction.

**A database cloned for a test file runs with JIT off too, set by `apps/api/test/file-database.ts`.**
A clone does not inherit a template's `alter database` settings, so until 2026-11-05 tests compiled
what a deployment never does, and that made `search_visibility_security_test.ts` fail on a busy
machine. A search test's rows then sat in one transaction that was never committed, so the planner had
no statistics on them: a search over the sample tenant was estimated at up to 943,373, past the 500,000
where Postgres also inlines and optimizes. At a load average of 37 on 18 cores, with Docker holding
10, one such search took 4,922 ms against its 5,000 ms limit, and compiling its 606 functions was
nearly all of it: `auto_explain` reported 3,147 ms optimizing and 1,684 ms emitting. At a load
average that never fell below 30.6, the file passed 20 of 20 runs with JIT off, and its slowest
search took 287 ms. In 5 runs in between, on the same code with JIT turned back on through
`PGOPTIONS`, 3 failed with "The search took too long" and 28 searches took over a second. So the
limit stays where it is, and a test now runs what a deployment runs.
`apps/api/src/db/file-database.test.ts` fails if a migration sets a database setting a clone lacks.
Stops being right if the stack's JIT decision above changes.

**A schema change adds one migration, exactly what `db:generate` writes, and an applied one is never
touched.** Until 2026-11-05 `db:generate` deleted `apps/api/drizzle/` and wrote one migration again,
which was right while nothing was deployed. A merge to main now deploys, and Drizzle's migrator
compares only times: it applies a migration timed after the last one a database recorded, and reads
no hash. `apps/api/src/db/migrations.test.ts` holds what that does on a deployed database. The first
migration written again with a later time fails with "already exists", and the api does not start. A
migration timed before the last one applied is skipped with no error, so a branch generated before
another that merged first would lose its change without a word.

`scripts/check-migrations.mjs` refuses the folder regenerated in place, an applied file changed, a
migration out of order or with no valid time, and any file the journal does not account for. It then
runs the generator over a copy of the base's folder and requires the branch's migration and snapshot to
match, so a hand-edited migration fails. Hand-written SQL belongs in `src/db/sql`, where it runs on every
start and must be idempotent.

**A rename takes two pull requests: add the new name, then remove the old one.** With no terminal the
generator fails where it would ask whether a removed name became an added one, and the check fails with
it. An earlier version let that case through with a notice, and a review on 2026-11-05 showed any
add-and-remove reached it, with no rename at all, and so did a table with `TTY` in its name, because
the version looked for that word in the output. A rolling deployment needs the two steps anyway: the
old code reads the old name until it stops.

**A column is dropped one release after the code stops reading it, and a key declared on a column
stays where it is.** Drizzle names every column of a table in a select with no field list and in every
insert, so a replica of the release before still names a column the next release dropped, and fails
while a rolling deployment overlaps the two. The release that stops reading the column ships first, and
the drop is the next migration. The drop's own overlap still fails an insert into that table from the
older replica, which names the column, until that replica stops. drizzle-kit 0.31 also never drops a
primary key declared on a column: it writes the `DROP CONSTRAINT` commented out, and the migration then
fails with 42P16 on every database, a new one too. Naming the key first fails the same way. The one
generated way round, dropping the column that holds the key, takes three pull requests and a new name
for that column. So `invite` keeps `token_sha256` as its key, with `id` unique beside it, and the routes
name an invite by `id` (2026-11-08). Stops being right if a drizzle-kit bump learns the name of a key
declared on a column, when moving the key is one migration.

The merge gate compares with the branch a pull request merges into, the first parent of its merge
commit, which needs no credential. Tier 3 compares with where the branch left main, so only the gate
sees a migration main gained since. This catches accidents, not intent: a pull request runs its own copy
of the check, and on the current GitHub plan neither the gate nor `CODEOWNERS` can be required, so a red
gate does not stop a merge. Nothing here covers how a new migration behaves on a deployment's rows, such
as `not null` with no default, or how long it waits on a lock. Stops being right if a Drizzle bump
changes how the migrator chooses, and that test file fails if it does.

**A start waits at most 30 seconds for a lock.** Until 2026-11-07 the migrator set no `lock_timeout`, so
a migration on a table an open sync held waited as long as the sync ran, and every other start queued
behind the advisory lock. `migrateDatabase` now sets 30 s on its own connection (`set_config`, not
local) for the advisory lock and the Drizzle migrations, and resets it before `collation.sql`, the
grants and the SQL files, which run unbounded as before: a start that failed on an open transaction
over `search_document` or `setting` would exit, restart and fail again. On `55P03` from the first two
(Drizzle wraps the driver's error, so `cause` is read) it throws an error that says it waited, who may
hold the lock, and that the next start tries again; the connection ends, which releases the advisory
lock. `collation.sql` keeps its own 400 ms inside its transactions and its own message. 30 s is longer
than a statement that only waits for a short transaction, and shorter than a sync of a large
workspace, which is the case it ends. A second replica that starts during a first one's migration of
more than 30 s also fails and is restarted by the orchestrator. Stops being right if a migration
legitimately holds a lock for longer than 30 s (a table rewrite), when it needs its own limit, or if
starts are not retried. `apps/api/src/db/migrate.test.ts` holds both waits.

## Tests on a busy machine

**A test that times out has its open sessions ended before the next test starts, and a search test
file builds the sample once and commits it to its own database.** `testTimeout` stays at 30 seconds.
Several sessions run tier 3 at once on one Mac (18 cores, Docker holding 10), and api tests were timing
out with no stall to find.

A test's time is its round trips multiplied by the cost of one, and both were high. A search test made
about 1,050 statements one after another, about 1,000 of them building the sample. During a run of the
api suite on 2026-11-05, a sparse `select 1` from the host through Docker's published port took a mean
of 2.57 ms and a p99 of 14.4 ms. The same statement at the same moment inside Docker's VM took a mean of
0.81 ms and a p99 of 5.4 ms. At load averages of 19 to 40, one test took 19.0 s: 1,018 statements at a
mean of 14.7 ms, the slowest 173 ms. So nothing stalled, and 28 ms a round trip spends the 30 seconds.
That cost did not follow the host's CPU alone: 24 `yes` processes on top left it where it was. Autovacuum
is not the cause either: waking every 5 seconds, it ran 36 times during the file, with no lock waits.

The failure at 13:10 on 2026-11-05 was three tests of `query.test.ts` in a row, each at exactly 30 s.
A proxy adding 50 ms to each round trip, with no stall anywhere, gave the same three tests in the same
order. The second and third sat on `Lock/transactionid` at their first insert, because vitest does not
stop the body of a test that timed out, its transaction stays open, and every test wrote the sample's
same primary keys. `log_lock_waits` is off, so Postgres logged nothing. With this decision the same 50 ms
passes both search files, 22 tests in 88.7 s. No test in them makes more than 95 round trips. With search's
visibility filter removed on purpose, the same 9 of the 10 tests in `search_visibility_security_test.ts`
fail on the old setup and the new one, so the file still catches what it did.

That 13:10 failure did not recur in 12 runs at those loads, so the link rests on the reproduction and the
measured cost, not on a trace of the failure itself.

The sample is committed rather than rolled back because a file's database is its own
(`apps/api/test/file-database.ts`), and `analyze` runs once after the build, so the planner reads the
same statistics in every test. Its hook has a limit of its own, 120 seconds, because no assertion runs
under it. A test with no provider clears the vectors, so it sees what the job with no provider leaves.

22 tests of the sync and the drafter still make over 1,000 statements each, and 175 make over 500, because
the work under test is what makes them. A timeout there now fails one test instead of the rest of its file.

`apps/api/src/db/file-database.test.ts` holds the sessions being ended. Stops being right if vitest
learns to stop a timed-out test's body, or if the api's tests stop crossing Docker's published port.

## Indexes are rebuilt when the server moves

**A PII rule lookup never reads `pii_rule_name_idx` by the fold, and each start of the api rebuilds
every index that depends on the collation when the server has moved since it was built, in
`apps/api/src/db/sql/collation.sql`.** An index keeps the keys and the order it was built with, so a
lookup through it can miss what is there. These runs are from 2026-11-05:

- **glibc 2.36 to 2.41** (Debian 12 to 13, Postgres 18.6, one data directory, the stack's own init
  script and migrations, the product's own functions). The sort order of every code point stayed the
  same, and `lower()` changed for 27 of them, the new case pairs of Unicode 16 such as U+A7DC. With a
  rule on a table whose name holds U+A7DC, `piiTableNamed` and `piiColumnNamed` answered false through
  the index, where a sequential scan answers true, and `saveRule`'s lookup found no rule, so a second
  rule got past the unique index. After the rebuild every answer was right.
- **Postgres 17 to 18** on one glibc, comparing every code point on the two servers, not through
  `pg_upgrade`. NFKC changed for 36 code points (U+1CCD6 to U+1CCF9); `lower()` and the order did not.
- **glibc 2.24 to 2.31** (Postgres 11, since no Postgres 18 image exists on a glibc that old, index
  scans forced, `lower()` in place of the whole fold). This move reorders text, so ordinary names
  miss: 34 of 41, such as `Customer 1` and `OrderLine`, and 0 after a reindex.

The lookups read through the index while `pii_rule` was never analyzed, at every size tried from 1 to
2,000 rules, and autovacuum leaves a table alone until 50 rows have changed. Once analyzed they read
sequentially up to at least 100 rules and through the index from 500. So the smallest deployments
were the ones that read through it.

### The lookups read no fold index

A lookup folds every rule once per statement and probes a hash (`ruleNamed` in
`apps/api/src/services/pii/rules.ts`), so no stale index can hide a rule, in any window, whatever
moved the server. `apps/api/src/services/pii/stale_index_security_test.ts` holds that on a really
stale btree, through `piiColumn`, `listColumns`, the search documents and the query check, and the
lookup this replaced fails all four. Rebuilding alone would have left PII showing between a move and the next start, and
the worker's search documents, which go to the embedding provider, were built through the same
lookup. It also costs less. Over 1,000,000 columns on one CPU, a count through the index took 5.4 to
8.3 seconds with 50 to 5,000 rules, and 2.4 to 2.9 by hash. The plain sequential scan a table
analyzed at 50 rules got took 134 seconds. A page of 50 took about 0.1 either way. A materialized scan
per lookup also reads no index and took 105 seconds at 50 rules, so it was not used. The scan may
still use the index for `kind` alone, which reads every rule of that kind whatever their folds, and
misses only if a move reorders those three words.

`saveRule`'s lookup and `suggest` can still read the index by the fold. A missed lookup in `saveRule`
adds a second rule, and PII wins between the two. A miss in `suggest` offers a column a rule already
covers, to an admin.

### The rebuild

Every index that depends on the collation is rebuilt, 89 of 153 on 2026-11-05, and not only
`pii_rule_name_idx`, because every text index can miss. Postgres's warning asks for that, and
refreshing the version after less would silence the warning for the rest. An index with no collated
key, expression or predicate is left alone, the HNSW index included.

The record is the comment on `pii_rule_name_idx`, because a table for it would change the one
migration, which a deployed database would then run again. It holds `version()` and the collation's
actual version. `version()` moves with any Postgres upgrade and with the distribution's build, so a
database on `C.UTF-8`, which reports no collation version, still rebuilds when the image moves. A
minor upgrade then rebuilds once too, for the seconds that costs. No comment counts as moved, so the
first start with this file rebuilds once. A `C.UTF-8` database whose glibc moves with no change to
`version()` is not noticed; the shipped images use `en_US.utf8`.

It runs before the migration's transaction and commits after each index. Inside the one transaction,
a rebuild waiting on one writer held every index it had already rebuilt, so reads of 40 other tables
stopped while `/health` stayed green (the security review ran it). Now a wait holds up one table, and the others carry on. That table's writers wait. Its reads wait too
if a transaction that already read it stays open, because the rebuild then holds the table and waits
for the index.

A start can land during a sync, which holds its locks for a whole workspace in one transaction. Each
lock waits 400 ms, and then the rebuild goes on to the other indexes and comes back to that one. A
minute with no index rebuilt fails the start, naming what held it, and the next start rebuilds again.
Only waiting counts, so a rebuild that takes longer than a minute still finishes. These are real
`storeWorkspace` calls on one CPU, with a start landing 3 seconds in and the rebuild due:

| Rows in the workspace | Store takes | Start, with a fixed wait of 30 seconds | Start, as built |
|---|---|---|---|
| 92,000, in 46 datasets | 4 to 9 seconds | finishes in 4 to 7 seconds | finishes in 1 to 3 seconds |
| 460,000 | 26 to 28 seconds | finishes in 24 to 27 seconds | not run |
| 800,000 | 40 to 59 seconds | fails at 30 seconds, and its restart finishes | finishes in 38 seconds |

The 400 ms also protects the sync. A transaction that reads a table and writes it later deadlocks with
the rebuild's wait for the index, and Postgres ends whichever's check finds it first, one
`deadlock_timeout` after that side began to wait. A sync that lost would end its run, because
`refusedByPostgres` treats that as an outage. A sync's write can only queue behind a rebuild that has
already begun, and the rebuild's two waits come to at most 800 ms, so it has let go before the default
of one second is up. The security review measured why it is not one second: a sync lost 14 of 80 rounds
when its write landed within a millisecond of the rebuild's wait, and 5 of 5 with a 900 ms wait when a
third writer let the rebuild in just behind the sync. `collation_security_test` holds both, and 30 runs
of those tests in a row passed. None of the 27 runs against a real store deadlocked, 7 of them with
these waits, so the window is narrow either way. That covers a sync's own write. A chain through a third
transaction's row can still end a sync's run: the review found one path, which needs an old api alive
during the start, as on a rollout on Azure, and costs that one run. A deployment with a shorter
`deadlock_timeout` loses the protection: a sync can lose and its next run catches up, and at 400 ms or
less a start can exit on the deadlock and its restart rebuilds again.

So short a wait never cancels an autovacuum, because Postgres signals one only after the waiter's own
deadlock check. An autovacuum on a table that outlasts the minute fails each start until it ends, which
clears by itself.

If a start dies part way, the indexes it rebuilt are right, and the unchanged record makes the next
start finish the job. A killed start's statement can carry on inside Postgres and finish, which is
right either way.

It needs only what the migrator has: it owns the database and every table, and is no superuser on
any target (`stack/postgres/init/01_roles_and_database.sh`, which `deploy/azure/main.bicep` runs too).
`collation_security_test` runs as that role. It has not run on a real Azure server. Where a managed
Postgres refused a statement, the api would not start, as with JIT above.

Where nothing moved it reads two catalogs and locks no table. The rest of a start is not free of locks:
`search.sql` and others take table locks every time, with no bound on the wait. With 1,000,000 columns and 100,000 tables
on one CPU, the whole migration took 4.3 seconds with the rebuild and 1.3 to 1.7 without. That run had no
measures, because its measure insert hit a unique key. Azure's startup probe allows 120.

A stale unique index can let in two rows that are the same key, and a sync through a stale index can
do it too. That index's rebuild then fails, the others it reaches finish, and no new api starts, so it never
serves a stale index after a start, except on a locale with no collation version, as above. Only the
api's start rebuilds (`apps/api/src/main.ts`), so a worker already running does not stop: it reads
through that one stale index until a person removes the row, and through every stale index until an
api start gets that far. The message
names every such index and never a key, since a key can be an email address, and neither the api's log
nor the server's holds it after the start. These builds use no parallel worker, because on a table of
8 MB or more a worker can log the error, key included, before the block can catch it. On a real move
with a 17 MB `pii_rule` and 51 duplicates, three runs of 20 starts with workers on put a key in the
server's log 12, 20 and 16 times, and none of 63 starts with them off did. On one CPU, as in the timing above, no worker runs anyway; on more, a very large table
takes longer to rebuild. A person runs `reindex index` on each as the migrator to see its key, which
that statement's own error does put in the server's log, looks the rows up with index scans off, since
the stale index can hide one, deletes the extra row, and starts the api again (the VM guide's Upgrading
section). For two rules, keep the one that says PII unless a person has reviewed
the name. The refusal is the safe side even with the lookups above, because other text indexes can
fail open. `setting` used to be read by key, and a missed row answered its default; the store now reads the whole table (one row per setting) and matches the key in code, so that index is not used for a read.

Stops being right if a column gains its own `COLLATE`, whose version `alter collation` refreshes and
this does not; if the migration can change on a deployed database, when the record belongs in a table;
if a rebuild outgrows the startup probe; or if one workspace's store regularly outlasts the minute. `apps/api/src/db/collation_security_test.ts` holds all of
it but a real move, which takes two servers: it leaves a real stale btree behind with a function that
lies about being immutable, and each way of breaking the rebuild that was tried fails it.

## Extension without plug-in code

**A company extends the product through custom fields, roles and policies, sign-in providers, agent
guidance, the change feed and the API. The core takes no plug-ins.** Taken 2026-10-25 (review item
18, and Martin's note that morning: more freedom than Metrics Book, never a fork). The connector's
tool surface is what the security tests cover, so a company's own MCP tools live in an MCP server of
their own, calling `/api/v1`. Stops being right if a use appears that none of the six places covers
and that a service account on the API cannot do.

## The MCP layer

**The MCP layer is the planner's small JSON-RPC layer, ported: one POST, one message, no session,
with the bounds (1 MiB, batches of 20, errors never reaching the client).** As Metrics Book ports
it. A session would keep state the security tests would have to cover. Stops being right if a
client needs server-sent events for a long query.

## Continuous integration

**GitHub Actions runs only the merge gate (lint, types, build, migration heads, lockfiles).** Martin's
rule: no test jobs. Tests run on the developer's machine in tiers (CONTRIBUTING.md), and the pull
request says what ran. Open: Metrics Book raises the same question about pull requests from outside
contributors once the repository is public, and a merge gate with no tests trusts the pull request's
own report. Deciding it needs the repository's visibility settled.
