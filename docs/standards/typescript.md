# TypeScript and React

TypeScript here is strict, reads the API's snake_case JSON as it is, and
fails loudly at the edge where bad input arrives. This holds for
`apps/api` (Hono on Node 24, the api and the worker), `apps/web` (the
React SPA), `apps/docs` (Starlight), `packages/powerbi-mock` and
`packages/tokens`. The rules on comments, errors and tests are the same as
in `python.md`; this file says how they look in TypeScript.

## Toolchain

- Node 24 (`.node-version`), pnpm 11 workspaces, ES modules only.
- A dependency is pinned exactly in the `package.json` of the package that
  uses it, and `pnpm-lock.yaml` is committed in the same change. pnpm
  refuses a version less than a day old.
- `prettier@3.9.10` formats; eslint with typescript-eslint's strict
  type-checked rules lints; `tsc --noEmit` checks types; vitest 5 runs
  tests, Playwright the UI flows. `pnpm fmt`, `pnpm lint`, `pnpm typecheck`
  and `pnpm test` run them across the workspace.

## Names

TypeScript follows its own language, not the snake_case of the rest of the
stack:

| Thing | Case | Example |
|---|---|---|
| values, functions, variables | camelCase | `createApp`, `isPublic` |
| types, interfaces, classes, React components | PascalCase | `Principal`, `GuardedFetcher`, `SetupStep` |
| module-level constant lists | UPPER_SNAKE_CASE | `PUBLIC_PATHS`, `SETTINGS` |
| file names | kebab-case | `public-paths.ts`, `info-views.ts`, `review-metric.tsx` |
| a Drizzle schema module | the area, kebab-case | `db/schema/mirror.ts`, `db/schema/service-accounts.ts` |
| tests | the module's file name, then `.test.ts` | `sign-in-providers.test.ts`, `secret-expiry.test.ts` |
| security tests | `<name>_security_test.ts` | `public-paths_security_test.ts`, `result_ownership_security_test.ts` |

- **The wire stays snake_case.** The JSON of the API and the MCP connector
  is snake_case, and TypeScript reads it as it is: `body.result_id`, never
  a layer that turns it into `resultId`. A type for a wire shape keeps the
  wire's keys, and so do the Drizzle columns (`expires_at`).
- **A security test is `<name>_security_test.ts`.** The name is either the
  module it guards, spelled as that module is (`public-paths_security_test.ts`,
  `grants_security_test.ts`), or the property it proves, in snake_case
  (`approval_browser_only_security_test.ts`,
  `metadata_visibility_security_test.ts`).

## Types

- `strict: true`, and `tsc --noEmit` passes.
- No `any`. No `as` to make an error go away (`as unknown as T` least of
  all). No `@ts-ignore`. No `!` to wave away a value that may be undefined.
  `@ts-expect-error` only in a test that proves a type refuses something,
  with the reason beside it.
- Every boundary takes `unknown` and parses it with zod into a type before
  use: a request body, the environment, a setting's value, an answer from
  Power BI, Microsoft identity, Graph, an embedding provider or Cerbos.
- The API's types come from its OpenAPI file, which is generated from the
  routes and checked in. The SPA and the CLI read them from there; nobody
  writes a second copy by hand.
- A closed set is a union of literals that matches the database's CHECK
  constraint: `"schedule" | "manual" | "deploy"`.
- One type per shape, with a discriminant when shapes differ:
  `kind: "person" | "service_account"` on `Principal`.
- An `interface` for a contract with two implementations, like
  `SecretReader` (Postgres with age, and the test double in
  `apps/api/test/doubles.ts`).

## Errors

- Handle an error where it can happen (I/O, parsing, the network, a
  person's input), with a decision for each.
- Never swallow one: no empty `catch {}`, no `.catch(() => undefined)`.
- No fallback that hides a bug. `?? []` or `?? {}` on a value whose absence
  means something broke turns a loud failure into a quiet wrong answer.
- No `try` around code that cannot throw.
- The database is the authority on what is valid. A CHECK or unique
  constraint refuses a bad write, and the code turns the constraint's name
  into a sentence. No second validator that can drift from it.
- A service throws `ServiceError(kind, message)` (`src/errors.ts`). The
  message is the sentence a person or an agent reads, with the one thing
  to do next. REST maps the kind to its status; MCP answers with the
  message.
- A refused dataset is thrown as `not_found`, never `refused`, so it
  answers exactly like a missing one, status and body alike.
- Power BI's refusal of a query (401, 403, 404) answers as a missing
  dataset too; a DAX error passes on Power BI's sentence.
- Internals never reach the client: no stack trace, SQL, token endpoint
  answer or Power BI request id passes through. The server logs them with
  the request id and the client gets the request id.
- Logs are one JSON line per request (method, path, status, `duration_ms`,
  `request_id`), never headers, cookies, bodies, tokens, DAX results or a
  secret. No emoji.

```ts
// Wrong: an answer without results reads as an empty table, and the agent trusts it.
const rows = answer.results?.[0]?.tables?.[0]?.rows ?? [];

// Right: executeQueries without a table is a broken answer, and says so.
const table = answer.results[0]?.tables[0];
if (table === undefined) {
  throw new ServiceError("upstream", `Power BI answered query ${queryId} without a table.`);
}
```

## The API (`apps/api`)

- `createApp(deps: AppDeps)` builds the app (`src/app.ts`), so a test
  builds it with its own database, fetcher, clock and doubles
  (`createTestDeps()`). No module holds a connection or a client of its
  own; everything it needs comes in `AppDeps` (`src/context.ts`).
- The environment is read once at start (`src/config.ts`), bootstrap
  values only, and start-up fails naming the variable that is missing or
  malformed. Everything else is a setting (`SettingsStore`) or a secret
  (`SecretReader`), read when it is needed.
- Every route checks its own credential. The public-paths list
  (`src/http/public-paths.ts`) names what is public, never what is
  protected.
- MCP tools and REST routes are thin adapters over one service layer,
  `src/services/`. A service takes a `ServiceContext` (the deps and the
  principal), asks `access.require(...)` before it reads or changes data,
  and is the only place a rule lives.
- A table belongs to one Drizzle module, `src/db/schema/<area>.ts`,
  exported with one line from `schema/index.ts`. The module declares every
  role's privileges on each of its tables with `declareGrants(...)`
  (`src/db/grants.ts`); `grants_security_test.ts` fails on a table with no
  declaration.
- SQL goes through Drizzle's query builder or its `sql` tagged template,
  with parameters. Never strings joined together; semgrep refuses it.
- `db:generate` adds a migration to `apps/api/drizzle/` when the schema
  changes. An applied migration is never edited, renamed or removed
  (`scripts/check-migrations.mjs`). Migrations apply at start, as the
  migrator, under an advisory lock.
- A book change and its event are written in the change's transaction
  (`recordBookChange`, `recordEvent`).
- An outbound request goes only through the guarded fetcher
  (`deps.fetcher`, `src/http/fetcher.ts`): `fetchFixed` for Microsoft
  identity, Power BI, Graph and the embedding provider; `fetchUntrusted`
  for a URL someone else chose. semgrep refuses `fetch` anywhere else.
- A secret is read with `deps.secrets.read(name)` where it is used, never
  kept in a module variable, logged, or put in an error.
- The api never calls into the worker: it asks with `enqueue(...)`, and a
  job runs where `registerJob(name, runner, handler)` says.

## The SPA (`apps/web`)

- Function components and hooks.
- Every datum comes from `/api/v1` through TanStack Query, typed from the
  OpenAPI file. The SPA keeps no data of its own, so it can never show what
  an API call could not.
- Routes through TanStack Router; each screen's route module is one entry
  in `src/router.tsx`.
- Styles from `@enum-studio/tokens` through Tailwind 4. No colour, size or
  font that is not a token.
- No `dangerouslySetInnerHTML`. Thread bodies are Markdown shown as text,
  never rendered as HTML.

## Tests

- vitest, one `<module>.test.ts` beside the module, named as the module is,
  in kebab-case. The spec's checklist names three in another form; their
  files are `apps/api/src/services/auth/sign-in-providers.test.ts`,
  `apps/api/src/services/setup/app-registration-check.test.ts` and
  `apps/api/src/services/admin/secret-expiry.test.ts`.
- Route tests call `app.request()` against real Postgres and Cerbos in a
  per-checkout container (`apps/api/test/database.ts`), never a mock.
  Power BI, Microsoft identity, Graph and the embedding providers are the
  mock in `packages/powerbi-mock`, started in-process with
  `startMockPowerBi()`.
- Security tests sit beside the code they guard, named
  `<name>_security_test.ts` as Python's are, so one pattern finds them
  all. `apps/api/vitest.config.ts` includes `src/**/*_security_test.ts`; a
  security test outside `apps/api/src/` does not run. The secrets tests are
  `apps/api/src/services/secrets/secret_at_rest_security_test.ts`,
  `apps/api/src/services/secrets/scanner_secret_isolation_security_test.ts` and
  `apps/api/src/services/secrets/secret_write_only_security_test.ts`.
- Playwright for UI flows, at 390 and 1440 px, in light and dark.
- Test first, assert behaviour, never edit a test to match broken code, and
  a skipped test is a failed test (`python.md`, Tests).
