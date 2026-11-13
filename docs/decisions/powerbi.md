# Power BI and its mock

## The Power BI mock

Where Microsoft's pages are silent or the mock deliberately differs, the
mock (`packages/powerbi-mock/src/powerbi/`) does the stricter thing. Each
choice below names the test that holds it.

### Build decides who may query

**`executeQueries` needs Build: an Admin, Member or Contributor workspace
role, or a direct share or an app audience whose right ends in `Explore`;
a workspace Viewer or a `Read` share or audience is refused.**
Microsoft: "The user must have dataset read and build permissions"
(Datasets - Execute Queries); "at least a Contributor role ... have Build
permission" (Build permission for shared semantic models); Build is
`Explore` in `DatasetUserAccessRight` (Get Scan Result). A service
principal holds Build only by its workspace role. Holds while Microsoft
keeps those roles; `query.test.ts` "who may query" checks each path.

### An app audience grants Build only with Explore

**An app audience entry grants Build on the datasets behind the app's
reports only when its right carries `Explore` (`ReadExplore`,
`ReadReshareExplore`); `Read` alone shows the reports and refuses
queries.** Decided 2026-10-25 by the coordinator. Microsoft lets an Admin
or Member publisher choose whether the audience may build content (Build
permission for shared semantic models), and its scan sample writes
`appUserAccessRight: "ReadExplore"`, so Power BI records the choice as
`Explore`. Stops being right if a real tenant's
`admin/apps/{id}/users` shows Build without `Explore`; `query.test.ts`
("an app audience with Read only") and `sample/access.test.ts` check it.

### Row-level security roles are not modelled

**The mock returns every row to anyone allowed to query; a dataset's
`has_row_level_security` only refuses service principals.** The sample's
Leader stands for a person in Finance's role. The product relies on Power
BI applying row-level security through each person's own token, never on
the mock. Stops being right when the product starts filtering rows itself,
which it must not.

### A refused query answers 403

**A caller without Build, or without workspace membership on the
`/groups/{id}` path, gets 403 `Forbidden`.** Microsoft's swagger lists only
200 for `executeQueries`. Stops being right when a recorded real refusal
shows another status; the product must not treat this 403 as an expired
token.

### Measure DAX needs write permission

**`INFO.VIEW.MEASURES()` writes null in `[Expression]`,
`[DetailRowsDefinition]` and `[FormatStringDefinition]` unless the caller
holds an Admin, Member or Contributor workspace role; names and
`[DisplayFolder]` stay.** Microsoft shows those three "only ... when run by
users with write permission". A dataset share with a `Write` right does not
count here, which is stricter than Microsoft may be. `query.test.ts` checks
it with Ben, who reaches the dataset only through the app.

### Refused INFO views

**A dataset with `refuses_info_views` answers every `INFO.VIEW.*` query
with 400 `DatasetExecuteQueriesError` and the sentence "INFO functions are
not supported by the executeQueries API."** The sentence paraphrases the
limitation on Microsoft's Execute Queries page; real tenants mostly answer
these views. The product must key on the status and code, never the text.

### Column types in scan results

**`columnType` is `RowNumber`, `Calculated`, `CalculatedTableColumn` or
`Data`, and a calculated column carries `expression` when
`datasetExpressions` and the DAX setting allow.** Microsoft's scanResult
schema defines neither field; the spec's mirror stores both. Stops being
right when a recorded real scan writes them differently.

### Queries the engine answers

**`EVALUATE 'Table'` leaves out the engine's `RowNumber-` column, and a
query may open with `DEFINE`; the mock ignores the definitions and answers
the `EVALUATE` after them when it is a form it knows.** A test that needs a
defined measure records the query in `recorded_queries`.

### modifiedSince and modified workspaces

**`modifiedSince` must read `YYYY-MM-DDTHH:MM:SS.fffffffZ`, with exactly
seven fractional digits; any other form, `+00:00` included, answers 400.
`admin/workspaces/modified` lists only workspaces whose `modified_at` is
later; a workspace without one counts as modified now.** Microsoft asks for
"ISO 8601 compliant UTC format" and its sample writes
`2020-10-02T05:51:30.0000000Z`. On a real tenant on 2026-11-03, seven digits
answered 200, and three digits or none answered 400 with "Date value should
be in ISO-8601 format". `scanner.test.ts` checks both.

### excludeInActiveWorkspaces is ignored

**The flag is read and changes nothing.** Microsoft does not say what makes
a workspace inactive, `state` is not it, and the tenant has no activity
data. Stops being right when Microsoft defines inactive.

### Relationships in scan results

**Every dataset in a scan result carries `"relationships": []`.**
Microsoft's sample answer does; its schema does not define the field. The
sync must read an empty array as "no relationships from the scanner" and
fall back to `INFO.VIEW.RELATIONSHIPS()`, never as "the model has none".

### admin/apps paging

**`$skip` below 1 on `admin/apps` answers 400, as does a missing or zero
`$top`.** Microsoft's reference gives both "minimum: 1". `admin/reports`
documents no minimum and takes `$skip=0`.

### admin/reports filters

**`admin/reports` evaluates only `$filter=appId eq '<id>'` and refuses
every other filter with 400.** The spec reads this list "for that app's
reports", which a client can do with that filter or by reading the whole
list; the mock serves both. Ignoring a filter would answer a looser list
than Power BI, so an unknown filter is refused instead.

### A scan can fail

**A workspace with `scan_failure` makes any scan holding it answer `Failed`, with an `error` in
Microsoft's `{ code, message }` shape.** Microsoft documents the status and the error on Get Scan
Status, and not what causes it, so this flag stands in for whatever does. `isolation_security_test`
uses it. Stops being right when a recorded real scan fails another way.

### Service principals by object id

**An access list names a service principal by its object id (Microsoft's
`graphId`), never its application id.** A workspace entry holding the
application id grants nothing; `query.test.ts` checks it.

## How the product uses Power BI

Taken in the spec of 2026-10-25 or during the build (2026-10-25 to 2026-10-27), as each says.

### Two app registrations, so the api never holds the tenant-wide credential

**The scanner (a service principal reading every workspace through the Admin Scanner API) and the
sign-in app (a person's delegated Power BI access) are two Entra registrations. Only the worker
reads the scanner's secret.** Taken 2026-10-25 (review item 4). The Scanner API is the only one that
returns measure DAX tenant-wide without membership in every workspace, and the api faces the
internet; with one registration, a hole in the api would hand over the whole tenant.
`docs/security/threat_model.md` names the boundary. Until 2026-11-03 the setup also refused a
sign-in app holding any application permission; "The setup checks the minimum" below replaced that.
Extras on a shared sign-in app partly undo this reason: an app holding `Tenant.Read.All` hands a hole
in the api the tenant's workspaces under that permission. The split still keeps the scanner's secret,
and the DAX and access lists only the scanner reads, out of the api's reach.
Stops being right if Microsoft returns measure DAX through a delegated token
for every person, which would make the scanner unnecessary for queries but not for the sync.

### The setup checks the minimum

**A sign-in app with a permission too many passes, with a note on what the check read; only a token
without Power BI's `Dataset.Read.All` fails.** Taken by the product owner on 2026-11-03. On a real
tenant the app worked, the person signed in and Power BI connected, and the setup still failed on
"The app registration holds App.Read.All". That app also served another product, so removing the
permission could break it, and this product never used it. The check had been refusing what it
could not improve.

`Dataset.Read.All` is the only requirement because it is the only one the check can read. The
redeem names the Power BI resource alone (`redeemCode` in `apps/api/src/powerbi/identity.ts`), so
the answer need not list Graph's `User.Read` or the sign-in scopes. Sign-in itself proves those: a
stored connection means an ID token and a refresh token came back.

The result stays in `setting_check.message`, with no new column, so one passing check holds one
fixed sentence of at most 300 characters: `permissionNote` in
`apps/api/src/services/setup/app-registration-check.ts`. A stored failure from before the change
needs nothing done in Entra: the setup's screen checks again by itself when it opens on a result
that leads nowhere, or one the daily run passed without marking the step
(`apps/web/src/setup/step.tsx`). The daily run alone would not free the person, because it does not
mark steps.

This gives up part of what two registrations were for. Whatever a shared app holds, a broken api
holds too: the app's secret and each person's token reach it, and an application permission does so
with no person behind it. The check reads only tokens for Power BI, so the note cannot show an
application permission on Microsoft Graph, and a name does not show every write. Whether a service
principal holding an application permission reaches workspaces nobody added it to is unverified
against Power BI; `docs/security/threat_model.md`, Residual risks, says what would verify it.

Stops being right if the product starts using a second delegated permission, which then joins the
requirement, or if Power BI ever refuses a query for a token holding more than it asked for. The
scanner is not part of this: it still fails on any `roles` claim. Proof:
`app_registration_check_security_test`, `apps/api/src/services/setup/setup.test.ts`.

### Queries run with the asking person's own token

**A query uses the person's delegated Microsoft token, encrypted at rest, never the scanner's and
never another person's.** Workspace access, app audiences and row-level security then hold because
Power BI applies them. Power BI's 401 means a stale token: the query service refreshes once and
retries, and a second 401 answers `not_found`. `invalid_grant` answers `needs_connection`. A 403 or
404 answers `not_found`, like a missing dataset, so the answer never says what exists. Microsoft's
`invalid_client` and `unauthorized_client` answer 409: the admin's to fix in the app registration,
not the person's to reconnect (a change to the spec). Stops being right if Power BI offers a way to
run a query as another person that Microsoft documents and audits.

### A workspace or dataset fails alone

**A workspace that cannot be scanned or stored, or a dataset or app that cannot be stored, costs
itself. The others are mirrored, the run ends failed, and it names what it left by id.** Taken on 2026-11-05 after
a review: one measure long enough to pass the scan answer's 32 MiB cap failed its whole batch of up to
100 workspaces on every sync, and a value Postgres refused failed the run. Anyone who can publish a
model writes what the worker reads.

- A scan whose answer passes the cap or holds a workspace this version cannot read, or that Power BI
  says failed, is halved until the workspace at fault stands alone. A refused request, a 5xx, a scan
  out of time, a read that times out and a gateway's page say nothing about what the scan held, so
  their batch fails whole. The run says how many workspaces that was, and the worker's log names them.
  A scan of one workspace that fails this way is named by its id, and that failure alone brings no
  advice to skip a workspace, as it says nothing of that workspace.
- Narrowing adds at most 300 scans to a run. One workspace at fault among 100 costs about 14, and
  Microsoft allows 500 scans an hour. Past 300 the scans left fail whole, and if Power BI lists
  workspaces in the same order, the same ones can on every run until an admin acts.
- Scans wait together, but their answers are read and stored one at a time. Four answers held together
  ran a 384 MB heap out of memory in the review's measurement. One answer did not, through the read and
  the store. The drafter, which reloads each dataset whole, was not in that measurement.
- Each app is stored in its own transaction, so one Postgres refuses costs itself, keeps its stored
  audience, and is named with its workspace. An audience Power BI answers 404 for, or that passes the
  limit or holds an entry this version cannot read, costs that app's audience alone. A 429, a 5xx or a
  gateway's page of any status says nothing of the app and the next would meet it too, so every app
  waits for the next sync, as they do when the list of apps or reports cannot be read whole. Power BI's
  own 404 is told by its error code, which the mock answers and a real tenant was not asked for here. If
  it held none, every app would wait for the next sync, and the run would say so. One entry in those lists that this version
  cannot read does that on every run, until the two agree. The drafts and embeddings go on in all of
  these.
- Each dataset is stored under a savepoint in its workspace's transaction. A query fails the dataset
  when its data can have caused it: SQLSTATE classes 21, 22, 23 and 54, and 08P01, which is what a
  statement past 65,535 parameters answers. An error outside a query, such as one in reading its DAX,
  fails the dataset too. Any other failed query is an outage or a mistake of ours that every dataset
  would meet, so the run ends.
- The cap stays. Raising it would hand a model the worker's memory, and 32 MiB is the fetcher's
  ceiling.
- A run still ends `failed`, because `modifiedSince` goes from the last run that succeeded. So a
  workspace that changed since then and fails is scanned again by every run, and every run fails until
  it can be read or is left out. This costs something: an incremental scan keeps reaching back to that
  run, and every sync is full once it is 30 days old, or at once if no run ever succeeded. An app
  Postgres refuses also fails every run, as every run stores every app.
- A full sync also reads what no incremental sync reads: a workspace nothing changed in, and every
  app's audience. A failure there waits for the next full sync, daily by default, and the incremental
  syncs between succeed, since they did all they do. Nothing changed in that workspace, so what can be
  out of date is its access list. The status page and `pbmb admin status` list `full_sync` until a full
  sync succeeds, so a green incremental sync does not hide it. Making the next sync full instead would
  let one workspace turn every hourly sync into a scan of the whole tenant.
- **Workspaces to skip** (`powerbi.sync.workspaces.exclude`) ends a failure, and the workspace ids a
  run names are what that setting takes: an app's or a dataset's own id saves and changes nothing. The
  next full sync then removes the whole workspace from the mirror, and no remedy works on one dataset:
  the dataset switch cannot stop a scan. Until that sync, an app in the workspace that Postgres refuses
  keeps failing each run, as apps follow the workspaces in the mirror, not the ones a sync reads.
- A run names by id, not by name, so its own words hold no name a model chose. Power BI's and
  Postgres's sentences are kept with what Postgres cannot keep taken out, and cut at 500 characters,
  and either could quote a value from the scan.

Stops being right if a run needs a third outcome, with the failed workspaces carried to the next run,
so `modifiedSince` can move on without them and what a full sync left is tried again within the hour.
Proof: `isolation_security_test`, and `status_security_test` for `full_sync`.

### What a model can put in a scan

**The sync cleans no value on its way into the mirror and checks no length. Microsoft's rules keep
what Postgres would refuse out of a model's names, and a workspace or dataset that holds one anyway
fails alone.** Read on 2026-11-05:

- Names: DAX syntax lists control characters as not valid in the names of tables, columns or measures
  (https://learn.microsoft.com/en-us/dax/dax-syntax-reference). Tabular's maximum capacity page gives
  object names 512 characters
  (https://learn.microsoft.com/en-us/analysis-services/multidimensional-models/olap-physical/maximum-capacity-specifications-analysis-services).
  That page is marked for SQL Server Analysis Services, not Power BI, and nothing narrower is
  published. At 3 bytes a UTF-16 unit that is 1,536 bytes, under Postgres's 2,704 for an index row, so
  a real measure name cannot fail `powerbi_measure_dataset_id_name_key`. A name is also unique in its
  model, so an upsert never touches a row twice.
- A NUL in a DAX expression: no page rules on it directly. Get Scan Result calls the field "A valid DAX
  expression", and Analysis Services' naming rules refuse a NUL in any string in its XML
  (https://learn.microsoft.com/en-us/analysis-services/multidimensional-models/olap-physical/object-naming-rules-analysis-services).
  Untested on a real tenant. The tests use one, and a 5,000 character name, because Postgres refuses
  them, not because Power BI sends them.
- A measure's length: no limit is published, so a very long one is reachable, and so is a batch past
  32 MiB without a crafted measure at all.
- How many measures: tabular allows 2^31-1 in a table, as a theoretical limit. The drafter's first run
  on a dataset emits one event for each filing and one for each new draft, and `withEvents` wrote them
  in one statement of six parameters an event. Past 65,535 parameters it failed that dataset: 10,922
  events, so about 5,460 measures of different calculations, or 10,922 identical ones. A real model
  can reach that with no crafted value, so the events now go in parts of 1,000.

Stops being right when a recorded real scan shows a control character or a name over 512 characters.
The guard still holds then, but that dataset stays out of the mirror until the sync can store the value.

### Workspaces and apps are both first class

**The mirror holds apps and the datasets behind them. Visibility and queries follow what Power BI
lets each person reach, through a workspace, an app audience, a direct share or a group.** Martin,
2026-10-25: companies organise access one way or the other, and it must work in both. Fails closed:
an access entry counts only with a right that is neither missing nor `None`, and a person's own
object id counts only while fresh (a Microsoft sign-in or groups read within 7 days). Microsoft
documents the app-audience query path but nobody has reported testing it. Stops being right if a
real tenant's app audience answers a query the mock refuses; see "A live test tenant".

### Relationships are read on demand, and only a 400 marks a dataset unavailable

**Only Power BI refusing the INFO functions (a 400) marks a dataset `unavailable` for everyone. A
403 or 404 is about the asking person's rights, so it answers unknown for that person and leaves the
dataset to someone who can read it. A failing read is tried once per person and dataset per 5
minutes.** A 403 or 404 says what this person may do, not what the dataset can do, so one person without
Build must not hide relationships from everyone. This amends "Relationships and display folders" in the
spec. Stops being right if Power BI returns relationships in the scan result for every dataset.

### A person's overlapping relationship reads wait for the one running, through Postgres

**A request that overlaps a person's read of a dataset's relationships, from the same person on the
same dataset and on any api replica, waits up to 30 seconds for that read and answers from what it
stored. The read in flight is a row in `model_view_read`, added in the transaction that counts it
against the 5 minute limit and deleted when it ends; the limit still counts only reads that may
start.** Before, the second of two overlapping requests (two tabs, an agent's parallel MCP calls, the
four size and theme e2e projects) was refused by the limit and answered "tried again in a few
minutes", though the first read finished about a second later, and the SPA did not ask again. A map
in the api process was the first fix, and it was wrong: the Azure deploy runs up to 3 api replicas
(`deploy/azure/main.bicep`, `maxReplicas: 3`), and an overlap that lands on two of them was refused
again. A refetch in the SPA would leave the CLI and agents with the wrong sentence. A Postgres
advisory lock would hold a connection for the whole Power BI read and one for each waiter, which a
burst of parallel calls turns into an exhausted pool; the row is claimed and read in short
statements, and a waiter looks every 200 ms. A request the limit refuses finds the row while the
read runs, because the count's upsert waits on the reader's uncommitted count; whatever it finds, it
looks at the dataset again once the wait ends, since the read may have ended before the first look.
It stops waiting when its caller goes away (the request's abort signal).

`started_at` is Postgres's `now()`, stamped by the claim and handed back to the reader, which
deletes its row by that value; the dead-reader check compares it with Postgres's `now()` too, so
the replicas' own clocks never meet in it. The column holds milliseconds, as a JavaScript `Date`
does, so the value handed back matches the stored one. A row that started more than 30 seconds ago
is not waited on: its reader died (a deploy stops a replica mid-read) or is too slow for the wait to
help. So a dead reader holds that person's requests on that dataset for what is left of its 30
seconds, then they answer "later" until the person's next read replaces the row, at most 5 minutes
on. A reader whose delete fails logs it and keeps its own answer or error; its row is then a dead
one. A dead reader's row stays, one small row per interrupted read, until that read is replaced or
the dataset is deleted; nothing sweeps them.

Proof: in `apps/api/src/services/mirror/info-views.test.ts`, "answers two overlapping requests from
one person with the one read" fails without the wait, "does not wait on a read whose reader died"
fails if a dead row is waited on, and "stops waiting on a running read when the caller goes away"
fails if the signal is ignored. In `apps/api/src/services/queries/query_identity_security_test.ts`,
"runs with each person's own token when two people overlap" fails if a read runs with another
person's token or the limit is not per person, and "never waits on another person's running read"
fails if the wait is not per person. Stops being right if a normal read takes longer than 30 seconds (the wait then answers
"later" more often than it helps), or if the limit stops being per person and dataset.

### The sync removes softly

**A workspace, dataset, table, column or measure the sync no longer sees gets `removed_at`. Only
access-list rows and app-dataset rows are deleted. No sync path moves or deletes a variant.** A
curator's filing must survive a re-sync (rule 9 in `AGENTS.md`). `powerbi.sync.workspaces.include`
is `"all"` or a list of workspace ids, default `"all"`; an empty list syncs nothing, and a full sync
also marks removed the workspaces the include and exclude settings now leave out. Power BI
enumerations are stored lower snake_case, mapped once in the scanner's schema (`column_type` is
`data`, `calculated`, `calculated_table_column` or `row_number`). Stops being right if a curator
needs to keep a metric whose measure was deleted; that would be a new state.

### A connection counts as tenant membership only while it is fresh

**A connection's Microsoft identity counts the person as a tenant member only while their groups
were read within 7 days, as a sign-in's groups do; a disconnect or `invalid_grant` ends it.** Without
the limit, a person removed from the tenant would keep seeing what `everyone_in_tenant` shows.
Open: Entra B2B guests carry the host tenant's `tid`, so they count as tenant members. Checking the
`acct` claim would separate them but needs the optional claim enabled on the app registration.

### The mock requires PKCE

**The mock requires PKCE (S256) on authorize for every client, stricter than Microsoft, which lets
confidential clients skip it.** The product always sends S256, so a product that dropped PKCE fails
its tests. Stops being right if the product needs a client without PKCE.

### A live test tenant

**Open.** Everything is proved against the mock, including the app-audience query path and the
click paths in the setup guide, which are sourced from Microsoft Learn and not walked in a real
tenant. A Fabric trial on an Enum Studio tenant would prove them; only Martin can set it up. Two
checks wait for it: the app registration check reads Power BI scopes as full URIs and fails a
correct registration on `Dataset.Read.All` if a real token lists it short, and it reads `scp` for
what the note names.
`pnpm test:live` is named in the spec for this and is not built.
