# The sample tenant, and moving to your own

Status: approved and built, 2026-10-27. Builds on `build/v1`.

## Goal

A person can try Power BI Metrics Book on invented data in a few minutes,
and later run it on their company's Power BI without any sample data left
in it. Being sample data is a fact about the tenant the stack is connected
to, not about any name inside it.

Martin, 27 October: try the sample to "kick the tires"; when you switch to
your real data you "don't suddenly have some sample data sitting around in
there"; sample-ness belongs "not in the dataset name itself but just in the
overall organization that you're connected to".

## When the sample, when your own tenant

The sample is for the time before you can connect your own tenant. That
takes two Entra app registrations, admin consent and a Power BI admin
setting, which in most companies means waiting on someone else for days.
Until then the sample answers the questions that decide whether to ask:
what an agent sees over MCP, how drafts become metrics with variants, how a
query hands back a preview and a CSV link. Developers, the end-to-end test
and the agent evals use it for the same reason: it is the same every time.

Your own tenant is for use. Nothing learned on the sample carries over
except what you write down: conventions, policies, settings.

## Today, read from the code

- `sample_data` is true when the host of `powerbi.authority` (set only in
  the environment) is localhost, `*.localhost` or a loopback address
  (`services/auth/sign-in-config.ts`). `GET /api/auth/config` and
  `GET /api/v1/me` answer it; the SPA shows a band. MCP and the CLI say
  nothing about it.
- Every name in the sample tenant starts with "Sample data: ". Docs that
  shorten them to Sales, Finance and Marketing break runnable commands.
- Nothing stops a database made on the sample from being started against
  a real tenant, or the reverse. `examples/sample/compose.mock.yml` only
  warns "Never layer this file over a deployment with real people in it".
- If it happens, sample to real: the scan soft-deletes the sample's
  workspaces, datasets and measures (`removed_at`) and keeps them. The
  book keeps every sample draft, metric, variant, term and category, and
  `book_change` their history. The query log, stored results and search
  documents stay. The sample admin keeps the admin role, sample people
  keep theirs, and setup stays closed because an admin exists, so nobody
  from the real tenant can become admin. The audit log keeps the sample's
  events, and nothing can remove them: the api may only insert into it.
- Real to sample, the worse way: the mock overlay sets
  `NODE_ENV=development`, which opens the dev sign-in over a database of
  real people, and the worker scans the sample into the real mirror.
- The band's link says "Connect a real tenant" and points at the app
  registration page, which invites exactly that.

## Design

### 1. A database belongs to one tenant, for life

The architecture already says one deployment serves one tenant
(`docs/decisions/architecture.md`). This makes the database hold it.

- A new table `deployment_tenant`, one row at most: `tenant_id uuid`,
  `sample boolean`, `bound_at timestamptz`. Grants: `api_rw` select and
  insert, `worker_rw` select, nobody update or delete.
- The row is written when the setup confirms the first admin
  (`firstAdmin` in `services/setup/link.ts`), from `powerbi.tenant_id`
  and `onTheMock(powerbi.authority)`. That is when the tenant's people
  first enter the database. Before it, the setup may still change the
  tenant id.
- A database that already has an admin and no row (one made before this
  change) is bound the same way at the api's start.
- At start, the api (`startApi`, after migrating) and the worker
  (`startWorker`) compare the row with their config. If `sample` differs
  from `onTheMock(powerbi.authority)`, or `tenant_id` from the
  `powerbi.tenant_id` setting, they log one sentence and exit non-zero.
  The sentence names both tenants and the way out, for example: "This
  database belongs to the sample tenant and the stack now points at
  Microsoft. A database keeps one tenant: start your own tenant on a new
  database (docs: /docs/start/sample-tenant/#move-to-your-own-tenant)."
- A trigger on `setting` refuses a `powerbi.tenant_id` other than the
  bound one, so neither the admin section nor `pbmb admin settings set`
  nor `book.yml` can move a bound database to another tenant (rule 3: the
  database is the authority).

Moving to your own tenant is therefore a new database. That is the only
reset that leaves nothing behind by construction: no list of tables to
keep up to date, no role that may delete the audit log, no sample admin
who has to run it and then cannot sign in.

### 2. The sample runs as its own Compose project

`examples/sample/compose.mock.yml` sets a top-level `name:
powerbi-metrics-book-sample`. Compose names volumes after the project, so
the sample gets its own Postgres volume even when the overlay is laid over
a company's own deployment directory. Moving on is:

```bash
docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml down --volumes
docker compose up -d
docker compose exec api server setup-link
```

The first command deletes the sample and only the sample. The real stack
starts on its own empty database, and its setup opens. The binding in 1
catches anyone who reuses a volume by hand.

What is kept: the deployment directory (`compose.yml`, `.env`, `access/`
policies and their tests, `book.yml`). Conventions you tuned while trying
move with `pbmb admin export` on the sample and `pbmb admin import` on the
new stack, after deleting the export's `role_assignments` and
`service_accounts`, the settings that name the sample's tenant and
registrations, and any workspace ids, which name the sample's people and
workspaces. The docs
page says so with the exact steps.

### 3. Sample-ness said at the tenant, everywhere a person or agent looks

| Where | What it says |
|---|---|
| SPA | the band, as now; its link becomes "Move to your own tenant", to the docs section of that name |
| `pbmb whoami` | a line `Tenant  the sample tenant: invented data, not your company's` when `/me` answers `sample_data: true` |
| MCP | the initialize instructions gain a first paragraph on the sample: "This deployment runs on the invented sample tenant. Every name and number is sample data, not the company's; say so when you report one." `whoami` answers `sample_data` |
| Docs | a page `start/sample-tenant.md` (below) |

`sample_data` in `GET /api/auth/config` and `GET /api/v1/me` keeps its
meaning and source. The public field does not change.

### 4. Names without the prefix

The sample tenant's names lose "Sample data: ":

| Kind | Now | After |
|---|---|---|
| workspaces | Sample data: Sales, Finance, Marketing | Sales, Finance, Marketing |
| personal workspace | Sample data: My workspace (Analyst) | My workspace (Analyst) |
| datasets | Sample data: Sales, Finance, Marketing, Campaign archive | Sales, Finance, Marketing, Campaign archive |
| apps | Sample data: Sales app, Leadership app | Sales app, Leadership app |
| reports | Sample data: Sales overview, ... | Sales overview, ... |
| groups | Sample data: Analysts, Leadership, Directors | Analysts, Leadership, Directors |
| people | Sample data: Admin, ... | Admin, ... |

Ids, emails (`@sample.example`, a reserved domain no real tenant can
verify) and the tenant id stay. Every test, the api and web end-to-end
tests, the agent evals, skills, docs, decisions and the mock's README
follow, as a mechanical rename. Rows of past runs in a decision's log
keep the names they had.

The docs rule, Martin's: a command meant to be run as written on the
sample tenant uses the dataset's real name, which is now plain `Sales`;
prose and illustrative examples use the same short names.

AGENTS.md rule 17 becomes: "The sample tenant is invented, and labelled
as sample data at the tenant: the SPA, `pbmb whoami` and the MCP
instructions say so."

### The docs page: `start/sample-tenant.md`

"Try it on the sample tenant", in the Start part after the quickstart:
when to use the sample and when your own tenant (the section above), the
commands from `examples/sample/README.md`, what the tenant holds (three
datasets, the same net sales under three names), the people to sign in
as, and "Move to your own tenant": the three commands in 2, what is kept,
and the refusal you see if a database is reused.

## Not doing

- An in-place "clear the sample data" step. Rejected in 1.
- Releasing the mock as an image so the sample runs without a checkout of
  this repository. It is a release decision; today the sample needs a
  checkout (`PBMB_REPOSITORY`). Follow-up.
- A `sample_data` field on every MCP answer or query result. The
  instructions and `whoami` reach every agent once per connection.

## Security

The binding is a trust boundary: it keeps the dev sign-in and the mock
from ever meeting a real tenant's database, and keeps a database on one
tenant. It gets a security review, `deployment_tenant_security_test.ts`,
and a paragraph in `docs/security/threat_model.md`. The test proves: a
sample-bound database refuses a real authority, a real-bound one refuses
the mock, a bound database refuses another tenant id through the settings
service and through SQL as `api_rw`, the api cannot update or delete the
row, and an unbound database starts.

## Tasks (sequential subagents on this branch)

1. **Rename.** Drop the prefix in `packages/powerbi-mock/src/sample/` and
   follow it through every file that names a sample entity. Mechanical,
   so it merges cleanly with `build/pii-and-datasets`. Verify: tier 2 for
   the mock, api and CLI, plus the web e2e fixtures' typecheck.
2. **Binding.** Section 1: schema, migration, grants, trigger, bind at
   confirm and at start, the start checks, the security test, the threat
   model. Then a security review.
3. **Signal and docs.** Sections 2 and 3, the docs page, the decisions
   (`architecture.md`, `look.md`), AGENTS.md rule 17.
4. **Check.** `pnpm check:all` under the stack lock, then one pull request
   into `build/v1`.
