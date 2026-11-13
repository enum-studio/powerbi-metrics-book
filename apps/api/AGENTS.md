# apps/api

The Hono app on Node 24, and the only process the internet can reach. It
mounts Better Auth on `/api/auth/*`, the MCP connector on `/api/mcp`, the
REST API on `/api/v1`, the setup API on `/api/setup` (its screen is the
SPA's `/setup`), and serves the built SPA and docs. The same image, started with `worker`, is the worker: the sync, the
drafter, embeddings, result expiry and the schedule.

Standards: `docs/standards/typescript.md`. Boundaries B1 to B9 of
`docs/security/threat_model.md` run through this package.

## Where things go

- `src/app.ts`: `createApp(deps)`, so a test builds the app with its own
  deps (`test/deps.ts`, `createTestDeps()`). `src/context.ts` declares
  `AppDeps` and the interfaces in it.
- `src/config.ts`: the bootstrap environment, read once at start. Start-up
  fails naming the variable that is missing or malformed.
- `src/http/`: middleware, the gate, the public-paths list, and the guarded
  fetcher (`fetcher.ts`), the one module that makes outbound requests.
- `src/services/`: the one service layer. MCP tools (`src/mcp/tools/`) and
  REST routes (`src/routes/v1/`) are thin adapters over it, so every
  caller reaches data the same way.
- `src/powerbi/`: the clients for Microsoft identity, the scanner,
  `executeQueries` and Graph.
- `src/db/schema/<area>.ts`: one Drizzle module per area, each declaring
  its grants; `drizzle/`: the migrations, generated and never edited once applied. `src/db/sql/<area>.sql`
  holds what Drizzle cannot express, applied idempotently after it.
- `test/`: the per-checkout Postgres and Cerbos, `createTestDeps()`, and
  an in-memory double of each interface in `AppDeps` (`doubles.ts`).
- Tests beside the code (`*.test.ts`). Security tests too, named
  `*_security_test.ts`.

## Rules here

- The public-paths list names what is public, never what is protected. Its
  test walks `app.routes`, so a route that is neither listed nor behind the
  credential check fails it.
- Every route checks its own credential, and ships with an authorization
  test: allowed and refused, for every role.
- Every data request asks Cerbos first (`deps.access`). A dataset the
  principal may not describe answers exactly like a missing one: throw
  `not_found`, never `refused`.
- A person's query runs with that person's own Power BI token; a result is
  read only by its owner. Neither is a policy: both are code with a
  security test.
- No MCP tool changes the book. Book changes go through the curation
  routes and `recordBookChange`, in the change's own transaction.
- The worker reads `powerbi_scanner_client_secret`; the api never does.
  Token keys live only in the api, so jobs that need them run with
  `runner: "api"`.
- Credentials are stored as digests; secrets and tokens only as age
  ciphertext for their reader. No route returns a secret's value.
- Outbound requests only through `deps.fetcher`. Settings only through
  `deps.settings`, never `process.env` outside `src/config.ts`.
- Logs: one JSON line per request, never headers, cookies, bodies, tokens,
  DAX results or secrets.
- The api is stateless: sessions, rate-limit counters and caches that
  matter live in Postgres.

Almost everything here is a sensitive path (auth, access, Power BI tokens
and clients, results, settings and secrets, MCP, database roles, the
guarded fetcher). A change gets the security review in
`docs/security/agents.md`, rule 3.

## Check

```bash
pnpm --filter @powerbi-metrics-book/api exec vitest run src/http   # tier 1: one folder or file
pnpm --filter @powerbi-metrics-book/api test                       # vitest, real Postgres and Cerbos
pnpm --filter @powerbi-metrics-book/api typecheck
```

Tests run on this checkout's own Postgres, with the real roles, and
Cerbos; Power BI is the mock, started in-process. Never a mocked database.
