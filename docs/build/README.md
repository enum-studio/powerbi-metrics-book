# Building v1: context every task shares

Read this, then your sudocode issue (`sudocode issue show <id>`), then the
spec sections the issue names. The issue is your whole task; this file is
what every task has in common.

- Repository: `enum-studio/powerbi-metrics-book`. Never push and never
  open a pull request; commit on the branch the harness gave you.
- Integration branch: `build/v1`. Spec:
  `docs/specs/2026-10-25-powerbi-metrics-book.md`.
- Sister product: Metrics Book (`enum-studio/metrics-book`), checked out
  read-only beside this repository (branch `build/phases-0-2`). Many issues say "adapt from" a file there: read it
  with `cat`, write your own version here, and never edit, commit or switch
  branches in that checkout. Its code is Enum Studio's own, Apache-2.0.

## The one rule that is not about code

This product is a clean-room rebuild of an idea first built for a client.
Never open, search or read the client's own repository or anything
else of that client's, and never write a client's name, a real company's
metric, dataset or person anywhere. The sample tenant is invented and
labelled as sample data at the tenant, not in its names.

## Your worktree's own environment

The harness may link a worktree's `.venv` and `node_modules` to the main
checkout's. A `uv` or `pnpm` command through that link rewrites the shared
environment. First thing in your worktree, before any `uv` or `pnpm`
command (paths named, not globbed):

```bash
for p in .venv node_modules apps/api/node_modules apps/web/node_modules apps/docs/node_modules packages/tokens/node_modules packages/powerbi-mock/node_modules; do
  if [ -L "$p" ]; then rm "$p"; fi
done
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
uv sync
pnpm install --frozen-lockfile
```

Never run `sudocode issue update`, `close` or any other sudocode write:
from a worktree it writes the main checkout's ledger. The coordinator sets
statuses. Reading (`sudocode issue show <id>`) is fine.

## Toolchain

- Node 24: this machine's default `node` is 22, so every shell that runs
  Node starts with `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
  pnpm 11.
- Python 3.13 through uv, from the repository root: `uv run <tool>`. The uv
  workspace holds `apps/cli` (package `powerbi_metrics_book`, command
  `pbmb`).
- Docker is available, shared by every agent on this machine (8 CPUs,
  8 GB). Keep containers small, name them after your worktree, and stop and
  remove them when you are done.
- A dependency must be at least a day old (pnpm's minimum release age
  refuses newer ones; hold Python packages to the same rule). The
  dependencies v1 needs are declared in the manifests by the baseline
  issue. If you must add one, add it pinned exact to the manifest of the
  package you own, run `pnpm install` or `uv lock`, and commit the lockfile
  with it; the coordinator resolves lockfile merges.

## Rules until the standards land, and after

- The standards are `docs/standards/` (naming, TypeScript, Python), and
  each area's `AGENTS.md`. Until the standards issue lands: snake_case
  wherever the language allows, TypeScript in its own idiom, the wire
  (JSON of the API and MCP) in snake_case read as it is.
- Code: `~/.claude/docs/code.md`. Comments say why. No swallowed errors, no
  silenced type checks, no hollow tests, no placeholder stubs, no emoji.
- Writing (docs, READMEs, commit messages, UI text):
  `~/.claude/docs/writing.md`. No em or en dashes, no curly quotes.
- Commit subjects are instructions ("Add the scanner's batch poller"). End
  every commit message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Touch only the files your issue's `files:` names, plus the shared files
  every issue may add its own lines to, without changing anyone else's:
  `apps/api/src/db/schema/index.ts` (one export line for your schema
  module), `apps/api/drizzle/` (generated, below),
  `apps/api/src/routes/v1/index.ts` (one line registering your route
  module), `apps/api/src/services/jobs/all.ts` (one import line for a module
  that registers a job), `apps/api/src/http/public-paths.ts` with its
  security test (a path you make public, and the test line proving it; a
  screen's issue adds `GET <its path>`, as `GET /sign-in`),
  `apps/api/src/http/static.ts` (a screen's issue appends the same paths to
  `SPA_PATHS`, which gives each its own route), and
  `apps/api/test/deps.ts` (building the real implementation you add), and
  `apps/web/src/router.tsx` (one import and one entry for your screen's
  route module). If
  the work needs any other file outside your list, stop and report.
- Tests: tier 1 (`~/.claude/docs/testing.md`) while working, your issue's
  `verify:` once at the end. Postgres and Cerbos in tests are real, in a
  per-checkout container, never mocked. Power BI, Microsoft identity, Graph
  and the embedding providers are the mock in `packages/powerbi-mock`. A
  skipped test is a failed test.
- No real credentials anywhere, no real tenant, no production.
- Text you write (docs, interface text, comments) holds no en or em dash and
  no curly quote: `node scripts/check-text.mjs <paths>` finds them. macOS
  grep has no `-P`, so never check this with `grep -P`.
- No directory named `identity` anywhere in the repository: `.gitignore`
  ignores `**/identity/` and the agents' settings deny reading it, because
  that is where age identities live. Name code about identities by what it
  does (`src/entra/`, `services/secrets/identities.ts`).

## Migrations

Deployments run, so an applied migration is never edited, renamed or
removed. When the schema changes, run
`pnpm --filter @powerbi-metrics-book/api db:generate`, which adds one
migration to `apps/api/drizzle/`, and commit what it writes, unedited. A
branch adds one migration. When main gains a migration while your branch has
one, or your schema changes again, take main's folder and run `db:generate`
again. A rename takes two pull requests: add the new name, then remove the old
one. `scripts/check-migrations.mjs` fails a branch that gets this wrong. Extensions (`vector`) are created
by the Postgres init script, never by a migration. Hand-written SQL that
Drizzle cannot express (a trigger keeping a `tsvector` current) lives in
`apps/api/src/db/sql/<area>.sql` and is applied after the migrations by
`src/db/migrate.ts`, idempotently.

## Names fixed across tasks

Use these exactly; several tasks build against them in parallel.

| Thing | Name |
|---|---|
| packages | `@powerbi-metrics-book/api` (`apps/api`), `@powerbi-metrics-book/web` (`apps/web`), `@powerbi-metrics-book/docs` (`apps/docs`), `@powerbi-metrics-book/powerbi-mock` (`packages/powerbi-mock`), `@enum-studio/tokens` (`packages/tokens`); Python distribution `powerbi-metrics-book`, package `powerbi_metrics_book`, command `pbmb` (`apps/cli`) |
| image | one, from `apps/api/Dockerfile`, tagged `powerbi-metrics-book`; its commands are `api`, `worker` and `server` (`server setup-link`, `server rotate-identity`) |
| compose services | `api`, `worker`, `postgres`, `cerbos`; in `stack/dev/compose.dev.yml` also `powerbi-mock` |
| compose networks | `edge` (proxy and api), `app` (api, worker, cerbos, postgres; `internal: true`), `egress` (api, worker) |
| compose volumes | `pgdata`, `api_identity` (api only, `/var/lib/pbmb/identity`), `worker_identity` (worker only, same path) |
| app database | `powerbi_metrics_book` |
| the image's runtime | `ENV NODE_ENV=production` set in the image (the api requires `NODE_ENV`; the dev and test overlays override it); user uid `10001`; the image mirrors the repository's layout under `/app`, so a path a module computes relative to itself works from source and from the image: `/app/apps/api/dist`, `/app/apps/api/src/db/sql`, `/app/access/policies` (the default Cerbos policies), `/app/conventions/presets`; the worker touches `/tmp/worker-heartbeat` at least every 30 seconds, which its health check reads |
| example environment files | `stack/env.example`, `examples/sample/env.example`: no leading dot, because agents may not read or write `.env*` files; a real deployment's file is `.env` |
| checking a compose file | `docker compose -f ... --env-file ... --dry-run create`, never `docker compose config`, which prints resolved secrets and which the agents' settings deny |
| the local connector's config | `pnpm dev:up` writes `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) at the checkout root, every run, with that checkout's `http://localhost:<api_port>/api/mcp`; both are gitignored, so the plugin carries no MCP server. `.codex/config.toml` stays committed with its `[mcp_servers.powerbi_metrics_book_dev]` block commented out; a person uncomments it and uses the port `dev:up` prints |
| the mock in the dev stack | the compose service `powerbi-mock`, reached as `http://powerbi-mock.localhost:<port>` (a container address, not loopback); its container reads `PORT` and `MOCK_ORIGIN`; the guarded fetcher allows that origin over `http` only when `NODE_ENV` is `development` or `test` |
| Postgres roles | `migrator` (owns every table), `api_rw`, `worker_rw`, `audit_writer` |
| bootstrap environment | `PUBLIC_BASE_URL`, `DATABASE_URL` (the container's own role), `MIGRATOR_DATABASE_URL` (api only), `AUDIT_DATABASE_URL`, `AUTH_SECRET` (api only), `CERBOS_URL` (`http://cerbos:3592`), `GIT_SHA` (or, when it is empty, the commit in `GIT_SHA_FILE`, which the image sets), `LOG_LEVEL`, `PORT` (api, default 3000), `NODE_ENV`, `ALLOW_DEV_SIGN_IN`, `API_AGE_IDENTITY` / `WORKER_AGE_IDENTITY` (optional), `IDENTITY_DIR` (default `/var/lib/pbmb/identity`) |
| settings and env overrides | a setting key `powerbi.tenant_id` is overridden by the environment variable `POWERBI_TENANT_ID` (dots and the key's own underscores become underscores, upper case); a secret `powerbi_app_client_secret` by `POWERBI_APP_CLIENT_SECRET` |
| public base URLs (settings) | `powerbi.authority` (default `https://login.microsoftonline.com`), `powerbi.api_url` (`https://api.powerbi.com`), `powerbi.graph_url` (`https://graph.microsoft.com`), `search.base_url` (null: the provider's own) |
| the mock's routes | under one origin: `{origin}/{tenant}/oauth2/v2.0/authorize`, `/token`, `/{tenant}/discovery/v2.0/keys` (identity, so `powerbi.authority = {origin}`); `{origin}/powerbi/v1.0/myorg/...` (so `powerbi.api_url = {origin}/powerbi`); `{origin}/graph/v1.0/me/transitiveMemberOf` (so `powerbi.graph_url = {origin}/graph`); `{origin}/openai/v1/embeddings`; `{origin}/gemini/v1beta/models/{model}:batchEmbedContents` |
| sample tenant | tenant id `11111111-1111-4111-8111-111111111111`; the people and groups are listed in `packages/powerbi-mock/src/sample/README.md` |
| HTTP prefixes | `/api/auth/*` (Better Auth), `/api/mcp` (connector), `/api/v1/*` (REST), `/api/setup/*` (the setup API), `/setup` and `/` (SPA), `/docs` (Starlight), `/health` |
| Power BI enumerations in the mirror | stored lower snake_case and mapped by the sync from Microsoft's spelling: `column_type` is `data`, `calculated`, `calculated_table_column` or `row_number` (from `Data`, `Calculated`, `CalculatedTableColumn`, `RowNumber`); a principal type is `user`, `group` or `app` (from `User`, `Group`, `App`) |
| ids on the wire | uuids as strings; an element is `{ "kind": ..., "id": ... }` with `kind` one of `workspace`, `app`, `dataset`, `table`, `column`, `measure`, `relationship`, `metric`, `variant`, `category`, `term`, `query`, `thread` |

## Interfaces fixed across tasks

The api's core issue writes these first; every other issue consumes them.
Signatures are TypeScript as written; field names on the wire stay
snake_case. The interfaces in `AppDeps` are declared in
`apps/api/src/context.ts` itself, so the core compiles before any of them
is built; each is implemented later in the module named beside it, and
`apps/api/test/doubles.ts` holds an in-memory double of each for tests
that do not need the real one.

### The app and its dependencies (`apps/api/src/context.ts`)

```ts
import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./db/schema/index.js";

export type Db = NodePgDatabase<typeof schema>;
export type Container = "api" | "worker";

export type AppDeps = {
  container: Container;
  db: Db;                 // the container's own role: api_rw or worker_rw
  pool: Pool;
  auditDb: Db;            // audit_writer: insert only
  config: Config;         // src/config.ts, bootstrap values only
  logger: Logger;         // src/log.ts
  clock: () => Date;
  fetcher: GuardedFetcher;   // implemented in src/http/fetcher.ts
  settings: SettingsStore;   // implemented in src/services/settings/store.ts
  secrets: SecretReader;     // implemented in src/services/secrets/store.ts
  access: Access;            // implemented in src/services/access/cerbos.ts
};

export interface GuardedFetcher {
  /** https to the configured hosts only (Microsoft identity, Power BI, Graph, the embedding provider). */
  fetchFixed(url: string | URL, init?: RequestInit & { timeout_ms?: number; max_bytes?: number }): Promise<Response>;
  /** A URL someone else chose (a CIMD document, an OIDC issuer): https, public addresses only, 5 s, 64 KiB, no redirects. */
  fetchUntrusted(url: string | URL, init?: RequestInit): Promise<Response>;
}

export type ServiceContext = AppDeps & { principal: Principal };
```

`createApp(deps: AppDeps): Hono<AppEnv>` builds the api, as in Metrics
Book's `apps/api/src/app.ts`; a test builds it with its own deps.

### Who is calling (`apps/api/src/principal.ts`)

```ts
export type Principal = {
  kind: "person" | "service_account";
  id: string;                            // Better Auth user id, or the service account's name
  roles: string[];
  attributes: Record<string, string[]>;  // includes powerbi_workspace_ids, powerbi_app_ids, powerbi_dataset_ids
  via: "browser" | "mcp" | "api" | "cli";
  client_id: string | null;
};
```

A person's principal is built in one place, whatever their credential
(`apps/api/src/services/auth/principal.ts`), with the roles that reach
them now and the attributes Cerbos reads:

```ts
export type Person = { id: string; email: string; email_verified: boolean };  // the Better Auth user
export function personPrincipal(
  deps: AppDeps,
  person: Person,
  channel: Pick<Principal, "via" | "client_id">,
): Promise<Principal>;
```

The `authenticate` middleware sets `c.var.principal` from a valid
credential (a session cookie, and each later credential's branch), then
`gate` turns away a request with no principal off the public paths, and
`requirePrincipal(c)` in a route refuses a person no role reaches. Every
`/api/v1` route and every MCP tool calls `requirePrincipal` before anything
else: the gate only checks that a credential was valid, and Better Auth's
own session routes are the only ones that answer a session no role
reaches.

A request that sends `Authorization: Bearer` on `/api/mcp` or `/api/v1` is
judged by its token alone, never by a cookie beside it. The origin check
(CSRF) guards what a browser's cookie authenticates: a state-changing
request with a bearer token and no cookie needs no Origin, because a
cross-site page can add that header only through a CORS preflight, which
the api never allows. A request carrying a cookie is checked whether or
not it also carries a token.

### Errors (`apps/api/src/errors.ts`)

```ts
export type ErrorKind =
  | "unauthenticated" | "refused" | "not_found" | "invalid" | "conflict"
  | "rate_limited" | "needs_connection" | "upstream";

export class ServiceError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}
```

The message is the sentence a person or an agent reads ("Your Power BI
connection expired. Reconnect at ..."). REST maps kinds to 401, 403, 404,
400, 409, 429, 409 and 502 with `{ "error": kind, "message": ... }`; MCP
answers a tool error with the message. A refused dataset is thrown as
`not_found`, never `refused`, so it answers like a missing one.

### Settings and secrets

```ts
// src/services/settings/registry.ts: every setting key, its zod schema and default
export const SETTINGS: Record<SettingKey, { schema: z.ZodType; default: unknown; description: string }>;
export interface SettingsStore {
  get<K extends SettingKey>(key: K): Promise<SettingValue<K>>;   // environment override, then database, then default
  set<K extends SettingKey>(key: K, value: SettingValue<K>, by: Principal): Promise<void>;  // validates
  source(key: SettingKey): Promise<"environment" | "database" | "default">;
}

// src/services/secrets/store.ts
export type SecretName =
  | "powerbi_app_client_secret" | "powerbi_scanner_client_secret" | "result_link_key"
  | "openai_api_key" | "gemini_api_key" | `sign_in_${string}_client_secret`;
export interface SecretReader { read(name: SecretName): Promise<string | null>; }      // only secrets this container reads
export interface SecretWriter { write(name: SecretName, value: string, by: Principal, expiresAt: Date | null): Promise<void>; }  // api only
```

### Access (`src/services/access/cerbos.ts`)

```ts
export interface Access {
  check(principal: Principal, resource: { kind: ResourceKind; id: string; attr: Record<string, unknown> }, action: string): Promise<boolean>;
  require(principal: Principal, resource: { kind: ResourceKind; id: string; attr: Record<string, unknown> }, action: string): Promise<void>;  // throws ServiceError
  describableDatasets(principal: Principal): Promise<SQL>;   // a Drizzle SQL condition over powerbi_dataset, from Cerbos planResources
}
```

### Jobs (`src/services/jobs/`)

```ts
export type JobName = "sync" | "expire_results" | "embed" | "rekey_tokens" | "refresh_idle_connections" | "check";
export function enqueue(db: Db, job: { job: JobName; runner: Container; args?: Record<string, unknown>; trigger: "schedule" | "manual" | "deploy"; requested_by?: string }): Promise<string>;
export function registerJob(name: JobName, runner: Container, handler: (deps: AppDeps, args: Record<string, unknown>) => Promise<void>): void;
```

### Database schema modules and grants

Each area has its own Drizzle module, `apps/api/src/db/schema/<area>.ts`,
exported from `schema/index.ts` with one line. A module declares the
privileges of each role on each of its tables by calling
`declareGrants({ <table>: { api_rw: [...], worker_rw: [...], audit_writer: [...] } })`
from `src/db/grants.ts`; `migrate.ts` applies them after the migrations,
and `grants_security_test.ts` fails when a table has no declaration or a
role holds a privilege its declaration does not list.

`applyGrants` also revokes everything from `public`, including `execute`
on every routine in schema public that no extension owns. A database
function the roles must call (rather than a trigger function, which needs
no `execute` to fire) therefore needs a declared grant: add a routine form
to `declareGrants` in the issue that adds the first such function, with
its security test line.

### Book changes and events (`src/services/book/changes.ts`, `src/services/events/feed.ts`)

```ts
// services/book/changes.ts
export function recordBookChange(tx: Db, change: { principal: Principal | null; element_kind: string; element_id: string; action: string; before: unknown; after: unknown }): Promise<void>;
// services/events/feed.ts
export type NewEvent = { kind: EventKind; element_kind: string | null; element_id: string | null; principal: Principal | null; data: Record<string, unknown> };
export function withEvents<T>(db: Db, work: (tx: Db, emit: (event: NewEvent) => void) => Promise<T>): Promise<T>;
```

A change that the feed must announce runs inside `withEvents`: `work` does
the change on `tx` (and calls `recordBookChange(tx, ...)`, which needs no
lock), and calls `emit` for each event. `withEvents` writes the collected
events as the transaction's last statement, under the feed's ordering lock,
then commits; if `work` throws, nothing is written. Never open a second
transaction for the events. A `null` principal is the system (the sync and
the drafter): `book_change` records it as `system` / `sync`. `EventKind` and
`EVENT_KINDS` come from `db/schema/events.ts`.

### Tests

- `apps/api/test/database.ts` starts (or reuses) this checkout's Postgres
  and Cerbos containers from `apps/api/test/compose.yml`, on ports derived
  from a hash of the checkout's path. Global setup builds
  `powerbi_metrics_book_template` once per run: a clone of the init
  script's database (so its roles, grants and extensions), migrated the way
  the api migrates at start, and marked as a template. A run whose
  migrations, grants and SQL are unchanged reuses it. Each test file then
  gets a database of its own, `pbmb_test_<time>_<random>`, cloned from the
  template by `apps/api/test/file-database.ts` (a vitest `setupFiles`
  entry) and dropped when the file ends. `roleUrl`, `testPool`,
  `testConfig` and `createTestDeps` all point at it, so a file cannot see
  another file's rows, locks, events, jobs or counters, and may commit
  freely. Cloning takes about 20 ms, and up to half a second on a busy
  machine. A database a killed run left is dropped by the next run's
  global setup once it is an hour old. The test server has 512 MB of
  memory and each running file holds about 15 MB of database, so
  `vitest.config.ts` caps the workers at 8.
- With `DATABASE_URL` set, the same works on a server someone else runs
  (Postgres 16 or later): `test_runner` must be allowed to create databases,
  to `set role` to `migrator` and to end sessions (`createdb`,
  `grant migrator`, `grant pg_signal_backend ... with inherit true`; see
  `CREATE_TEST_RUNNER` in `test/database.ts`) and to connect to the server's
  `postgres` database.
- `apps/api/test/deps.ts` exports `createTestDeps(overrides?)` and
  principals for each shipped role.
- `startMockPowerBi(options?)` from `@powerbi-metrics-book/powerbi-mock`
  returns `{ url, close, setActingUser(objectId) }`.
- Security tests are named `*_security_test.ts` and sit beside the code
  they guard; the vitest config includes them.

### Test helpers

Test-only helpers, fixtures and doubles live in `apps/api/test/` (and a
package's own `test/` folder), never under `src/`: the build compiles
everything in `src/` except `*.test.ts` and `*_security_test.ts` into the
image. Name a new helper after what it serves (`test/secrets-support.ts`,
`test/settings-fixture.ts`).
Reuse the database helpers before writing a new one: `test/db-roles.ts`
(`asRole`, `inRolledBack`) and `test/sample-mirror.ts`
(`inSampleMirror(role, (tx, sample) => ...)`, which loads the sample
tenant's mirror as the worker and acts as `role` in one transaction that is
always rolled back, and `setRole(tx, role)`). Hand that `tx` to a service as
its database and the service's own transactions become savepoints, so
`inSampleMirror` commits nothing. It runs as `test_runner`, a role
`test/database.ts` makes for the tests alone (never in the stack's init
script). Each test file has a database of its own, so a test may count
every row and event in it and commit jobs to the queue, and the sample's
fixed ids never meet another file's. Only the tests of one file share a
database, and they run one after another.
A test that needs the sample drafted and embedded costs about 1,000 statements
to set up, so `useSearchable()` (`test/search-support.ts`) builds it once per
file and commits it, and `searchable(options, work)` rolls each test back
(`docs/decisions/architecture.md`, "Tests on a busy machine").
`eventsSince(tx)` (`test/events.ts`) reads the events a transaction writes
from the moment it is called. `freshPeer()` (`test/sign-in-support.ts`)
gives each request its own address, so rate limits count it alone.
`waitingOn(pid, count)` (`test/locks.ts`) waits until sessions queue behind
a lock a test holds.
`packages/powerbi-mock` is test infrastructure as a whole and never ships
in the product's image, so its helpers may live in its `src/`.

### CLI (package `powerbi_metrics_book`)

`powerbi_metrics_book.cli:app` is the Typer app behind `pbmb`. It
registers every module in `powerbi_metrics_book/commands/`: a module that
defines `app: typer.Typer` becomes a command group (`pbmb metrics list`), a
module that defines `command` becomes one command (`pbmb whoami`). Every
command takes `--json` and then prints one JSON document to stdout and
nothing else. Every remote command goes through
`powerbi_metrics_book.client.Client` (base URL, credentials, errors).

### The CLI's OAuth client

The CLI is a first-party public OAuth client the api registers itself at
start: client id `pbmb-cli`, no secret, grants
`urn:ietf:params:oauth:grant-type:device_code` and `refresh_token` only,
resource `<PUBLIC_BASE_URL>/api/v1`, scopes `api` and `offline_access`. The
device grant is served by the same OAuth provider and token endpoint as the
MCP clients' grants, so it answers an access token and a refresh token with
the same rotation and reuse detection (not Better Auth's device plugin's
session token).

Scopes: `mcp` covers `/api/mcp`, `api` covers `/api/v1`, and
`offline_access` brings a refresh token. An access token is a one-hour JWT
whose `aud` is the one resource it was issued for: at the other resource it
is answered 401 `invalid_token`, and without the resource's scope 403
`insufficient_scope`. Roles are never in a token; they are read per request.

- Endpoints are discovered, never hard-coded: `pbmb login` reads
  `GET <url>/.well-known/oauth-authorization-server` (RFC 8414) and uses its
  `device_authorization_endpoint` and `token_endpoint`.
- `pbmb login` posts to the `device_authorization_endpoint`, form-encoded,
  exactly `client_id=pbmb-cli`, `scope=api offline_access` and
  `resource=<url>/api/v1`, and nothing else. Another client id is refused
  `invalid_client`, a missing resource `invalid_target`, a scope without
  both `invalid_scope`, and a `user_id`, a repeated field or a body that is
  not form-encoded `invalid_request`. The answer holds `device_code`,
  `user_code`, `verification_uri` (`<url>/device`), `expires_in` (600) and
  `interval` (5), and no `verification_uri_complete`: the CLI shows the
  code and the URI, and the person types the code at `/device`, which shows
  when and from which address the request started, then presses Allow.
- It then posts to the `token_endpoint` every `interval` seconds,
  form-encoded, `grant_type=urn:ietf:params:oauth:grant-type:device_code`,
  `device_code` and `client_id=pbmb-cli`. `authorization_pending` means
  wait; `slow_down` means add 5 seconds to the interval; `access_denied` and
  `expired_token` end the login. Success answers `access_token`,
  `refresh_token`, `token_type` (`Bearer`), `expires_in` (3600), `expires_at`
  and `scope`.
- `~/.config/pbmb/credentials.json` (mode 0600, written atomically) holds
  `url`, `client_id`, `token_endpoint`, `access_token`, `refresh_token` and
  `expires_at` (ISO 8601, UTC).
- Refresh, on a 401 or within 60 seconds of `expires_at`: `POST` to the
  stored `token_endpoint`, form-encoded, `grant_type=refresh_token`,
  `refresh_token`, `client_id` and `resource=<url>/api/v1`; the new refresh
  token is saved before the new access token is used, and an
  `invalid_grant` answer deletes the saved login and says to run
  `pbmb login` again. A refresh token works once: presenting a used one
  revokes the whole login, every token of it at once.
