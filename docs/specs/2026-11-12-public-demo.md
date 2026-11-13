# The public demo

Status: draft for Martin's review, 2026-11-12.

## Goal

Anyone can open the product from the website and look around, with no
sign-up and no sign-in: the web app and the docs, on the invented sample
tenant, read-only.

Martin, 12 November: "a demo account that we can link to from the website,
where you can just go in and see the UI and see how things work". And: "you
actually don't need to have a login on this", "there's no ability to
actually connect with it from Claude and set up the MCP server", "it's more
a mock of all of the documentation and the UI".

Done when demo.powerbimetricsbook.io opens on the home page of the sample
tenant's book, a visitor can browse metrics, variants, categories, terms,
datasets, tables and columns and search them, read the docs at `/docs`, and
cannot change anything, sign in, connect an agent or run a query. The
website links to it.

## Non-goals

- Sign-in of any kind, visitor accounts, sessions.
- MCP, the CLI, OAuth clients, API keys, the REST API for anything but the
  web app's own reads.
- Queries. The web app has no screen that runs DAX, and the demo person has
  no Power BI connection.
- Admin, review and curation screens. The demo person is a viewer.
- A nightly reset. Nothing a visitor does is written (see 3), so the book
  never drifts.

## Design

### 1. Demo mode, and why it cannot open on a real deployment

A new bootstrap flag, `DEMO_MODE`, read by `loadConfig` with `readFlag`
(`1` on, unset or `0` off, anything else stops start-up) into
`config.demo_mode`, for the api and the worker.

Demo mode is open only when all of these hold. The api and the worker
check them at start (`refuseDemoOffTheSample` in
`apps/api/src/services/demo/locks.ts`, called beside `refuseAnotherTenant`
in `startApi` and `startWorker`, and before each job like
`refuseAnotherTenant` is), and with `DEMO_MODE=1` and any of them false
they exit non-zero with one sentence naming the one that failed:

1. `ALLOW_DEV_SIGN_IN` is not `1`. Checked in `loadConfig`: "DEMO_MODE and
   ALLOW_DEV_SIGN_IN cannot both be 1".
2. `powerbi.authority` is on the mock (`onTheMock`). The setting is read
   from the environment only, so the admin section cannot change it.
3. The database is bound to the sample tenant (`boundTenant(db).sample`),
   or not bound yet. A real deployment's database is bound to its real
   tenant at its first admin, and the `setting` trigger refuses a later
   tenant id, so it can never satisfy this.
4. `usage.capture` is false, so a visitor's search is never written.
5. In the api only, the client address can be named: `trusted_proxy` is
   set or `client_address_header` is `x-real-ip`. Otherwise every visitor
   is the proxy's address, and the per-address request and search limits
   become one limit that one script can spend for everyone. The worker
   serves no visitor and has no `TRUSTED_PROXY`, so it skips this lock.

Why each matters: with 1 open, anyone could sign in as the admin; 2 and 3
keep demo mode off any database holding a company's people and Power BI;
4 keeps the demo free of writes per visitor.

`NODE_ENV` stays `production` in the demo: secure cookies, HSTS, the
`SampleOnly` refusal of public secret values, and the dev sign-in's own
lock all apply.

### 2. The guarded fetcher reaches the mock over http in demo mode

`fetchFixed` refuses http in production today, and the demo's mock is
`http://powerbi-mock.localhost:<port>` on the stack's `egress` network
(as in `stack/dev/compose.dev.yml`). `createGuardedFetcher` takes a new
option, `demoMock: boolean`, set from `config.demo_mode`. When it is true,
`fetchFixed` allows `http:` for a target whose host passes `onTheMock`'s
host test (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), and only for
the configured origins, which are unchanged. `fetchUntrusted` is
unchanged: https only, internal addresses refused.

`buildAuth` (`services/auth/better-auth.ts`) refuses a `powerbi.authority`
that is not https outside development and test. In demo mode it also
accepts an http authority whose host passes the same host test, so the
Microsoft sign-in the seed walks (section 5) works with
`NODE_ENV=production`. Added 2026-11-12, during the build: the threat
model's B4 named the check.

Every outbound call then goes to the mock: Microsoft identity, Power BI,
Graph, the embeddings (`SEARCH_BASE_URL` at the mock's `/openai`) and email
(`EMAIL_BASE_URL`). Nothing leaves the stack and nothing costs money.

### 3. One demo person, no credential, GET only

In demo mode every request is the demo person, `viewer@sample.example`,
the sample tenant's Viewer (`packages/powerbi-mock/src/sample/README.md`).
The constant is `DEMO_PERSON_EMAIL` in `services/demo/person.ts`.

- An app serves the demo when `createApp`'s `serveDemo` is true, which it
  is by default when `config.demo_mode` is (section 5 builds one that does
  not). `authenticate` (`services/auth/principal.ts`) is given the flag,
  and in an app that serves the demo it reads no cookie and no bearer
  token and sets nothing. A credential a request carries is ignored, so the
  seed's admin session, or anyone's, does nothing here.
- Before the gate, a new middleware, `demoRequests` in
  `apps/api/src/http/demo.ts`, registered in `createApp` only when the app
  serves the demo, judges each request in this order:
  - Each client address gets `DEMO_READS_PER_MINUTE = 240` requests a
    minute through the Postgres limiter in `services/rate-limit.ts`, keyed
    `demo:<address>` with `client-address.ts`'s address. Over it: 429 with
    `Retry-After`. Every request counts, a refused one too.
  - A request whose method is not GET or HEAD answers 403
    `{ error: "refused", message: "The demo is read-only." }`.
  - A GET or HEAD whose path is not in `DEMO_PATHS` answers 404, as a
    missing route does, or the redirect below.
  - A path in `PUBLIC_PATHS` goes on with no principal, so a screen, an
    asset or the sign-in config never looks the demo person up.
  - Any other path is answered as the demo person: `asDemoPerson` sets
    `c.var.principal` with
    `personPrincipal(deps, demoPerson, { via: "browser", client_id: null })`
    for the user whose email is `DEMO_PERSON_EMAIL`, and `c.var.identity`,
    and no `c.var.person` (no session). Until the demo person exists (the
    seed has not finished), it answers 503
    `{ error: "unavailable", message: "The demo is being set up. Try again in a minute." }`.
- Search's own limit (`SEARCH_RATE`, `services/search/query.ts`) counts
  per principal, and every visitor is the one demo person, so in demo mode
  it counts per client address instead, keyed `search:demo:<address>`.
  The REST adapter puts the address on the `ServiceContext` (the
  connector is not served in the demo, and sets none); a demo search
  without one is refused with 403 rather than counted against a key every
  such search would share.
- `DEMO_PATHS` (`apps/api/src/http/demo-paths.ts`) names what a visitor
  may reach, in the format of `PUBLIC_PATHS`, GET only:
  - `/health`, `GET /api/auth/config`, `GET /api/branding/logo`;
  - the web app's shell: `GET /`, `GET /assets/:file`, and the home and
    catalog screens in `SPA_PATHS`, not `/sign-in`, `/invite`,
    `/forgot-password`, `/set-password`, `/oauth/consent`, `/device`,
    `/settings/*`, `/setup`, `/admin*` or `/review*`;
  - the docs, `/docs/*`;
  - the `/api/v1` reads the home and catalog screens make: `GET /api/v1/me`
    and the catalog's list, get and search routes. The implementer lists
    each one from the screens' calls (`apps/web/src/catalog/queries.ts`,
    `apps/web/src/home/`), and every GET that writes is left out, above all
    `GET /api/v1/powerbi/connect` and `GET /api/v1/results/:id/csv`.
  It never names `/api/mcp`, `/api/auth/*` beside the config, `/api/setup*`
  or `/.well-known/*`, so in demo mode those answer 404.
- The SPA's shell path for a screen not in `DEMO_PATHS` (`/sign-in` and the
  rest above) redirects to `/` with 302 rather than answering 404, so an
  old link lands somewhere.
- `GET /api/auth/config` answers `demo: true` in demo mode, `false`
  otherwise, beside `sample_data`.

What a visitor can therefore do is read, as the Viewer, with
`access.metadata_visibility = everyone` so every sample dataset shows,
and nothing they do is written. There are two exceptions: the rate
limiters' counter rows, one per address per window, and one
`embedding_usage` row per search, priced at the mock's rate, which costs
nothing.

### 4. The web app in demo mode

With `demo: true` from `/api/auth/config`:

- The sample-data band reads "Demo on invented sample data. Read-only."
  with a link "Run it on your own Power BI" to
  `/docs/start/`. Wording through the `copywriting` skill.
- No sign-out, no Settings, no Connections in the menu. The menu shows
  the catalog and the docs.
- Controls that write (post a thread, reply, upvote, record a request,
  accept a reply) are not shown.
- A 403 with "The demo is read-only." shows as that sentence, in the
  existing error display.

### 5. Seeding: `server sample-seed`

The sample tenant's first-run setup and its book are written today by
`scripts/dev-stack.mjs` and `scripts/sample-book.mjs`, which drive the api
over HTTP from the host and set the mock's acting user through its control
route. The demo has no host to run them from and no non-demo api to drive.

The walk moves into the image as one command, used by both:

- `server sample-seed` (`apps/api/src/services/sample/seed.ts`, registered
  in `server.ts`): refuses unless `powerbi.authority` is on the mock. It
  loads the api's config as the environment gives it (in the demo,
  `DEMO_MODE=1`, so the locks of section 1 and the http allowances of
  section 2 apply to the seed too), builds deps and
  `createApp(deps, { serveDemo: false })`: an app without section 3's one
  person and read-only rule, which only the seed's own process holds and
  nothing outside it can reach. `createApp`'s second argument is an
  optional options object, `{ webDist, docsDist, serveDemo }`, and
  `serveDemo` defaults to `config.demo_mode`. (Changed 2026-11-12,
  during the build: the first version forced `demo_mode` off, which also
  took away the http allowances the seed needs.) It drives that app in process with `app.request()`,
  as a browser would: a setup link (the same function `server setup-link`
  uses), the address, app registration and scanner steps, Microsoft's
  sign-in as the sample admin at the mock (acting user through the mock's
  control route, the redirect followed), the confirmation, the Power BI
  connection, what to sync, the first sync (waiting on the worker), the
  search and agents steps as dev-stack sets them, then the sample book
  (the categories, filings, merges and terms of `sample-book.mjs`, moved to
  `services/sample/book.ts`), and last Microsoft's sign-in as
  `DEMO_PERSON_EMAIL`, so the demo person's user exists. A second run
  finds an admin and only seeds the book again, which changes nothing.
- `scripts/dev-stack.mjs up` runs `docker compose exec api server
  sample-seed` instead of its own walk. `--no-setup`, `setup-link` and the
  report stay as they are. `scripts/sample-book.mjs` goes.

In the demo, a one-shot `seed` service runs it (6).

### 6. The demo deployment: `deploy/demo/`

- `deploy/demo/compose.demo.yml`, layered over `stack/compose.yml` and
  `deploy/dokploy/compose.dokploy.yml`:
  - `powerbi-mock` as in `stack/dev/compose.dev.yml`: on `egress` only,
    alias `powerbi-mock.localhost`, no published port, `MOCK_CONTROL=1`
    (reachable only by the stack's own containers),
    `SAMPLE_PUBLIC_BASE_URL` the demo's address;
  - `api` and `worker`: `DEMO_MODE=1`, `NODE_ENV=production`, the
    `POWERBI_*`, `EMAIL_BASE_URL` and `SEARCH_BASE_URL` overrides at the
    mock, `USAGE_CAPTURE=false`,
    `ACCESS_METADATA_VISIBILITY=everyone`;
  - `seed`: the product image, `server sample-seed`, the api's environment
    with `DEMO_MODE=1` (section 5), `restart: "no"`, after `api` and
    `worker` are healthy, on `app` and `egress`.
- `deploy/demo/README.md`: the exact Dokploy steps for a person with
  production rights: a new project (never the production one), the
  compose path and command, every environment variable with how to make
  its value (`openssl rand`), the domain `demo.powerbimetricsbook.io` and
  its DNS record, `TRUSTED_PROXY` as the Dokploy guide sets it, the first
  deploy, how to see the seed finished, and how to start over (remove the
  volumes, deploy again).
- `apps/api/src/stack/compose_security_test.ts` also reads the demo
  layer: only `api` has a domain or port, the mock publishes nothing and
  is not on `app`.

### 7. The website and the docs

- `apps/site`: "Try the demo" in the hero beside the existing call to
  action, and in the nav, to `https://demo.powerbimetricsbook.io`. Copy
  through the `copywriting` skill. Kept small; rebased on the "go public"
  pull request.
- `apps/docs/src/content/docs/start/`: a short section on the demo: what
  it is, that it is read-only on invented data, and that the sample tenant
  on your own machine is where agents connect.

### 8. Security

- `docs/security/threat_model.md`: B1 gains demo mode (one principal, GET
  only, `DEMO_PATHS`, the five locks); B4 the http exception for the mock;
  residual risks gain the demo's own (a crawler can read the whole sample
  book, which is public by design; the limiter's rows).
- Security tests, `apps/api/src/http/demo_security_test.ts` and
  `apps/api/src/services/demo/locks_security_test.ts`:
  - each lock in 1 refuses start on its own, with the others open;
  - in demo mode a POST, PUT, PATCH and DELETE to every route in
    `app.routes` answers 403, and a GET to every route not in
    `DEMO_PATHS` answers 404, or 302 to `/` for a web app screen
    (walking `app.routes`, as the public-paths test does);
  - every entry of `DEMO_PATHS` is GET or HEAD;
  - a request with the admin's session cookie, or a bearer token, is the
    demo person;
  - `/api/mcp`, `/api/auth/oauth2/register`, `/api/auth/device/code`,
    `/api/setup` and `GET /api/v1/powerbi/connect` answer 404;
  - the 241st request in a minute from one address answers 429;
  - with demo mode off, nothing changes: the existing authorization matrix
    passes as before;
  - `fetchFixed` with `demoMock` allows http only to a mock host among
    the configured origins, and refuses http to any other host.
- The `security-reviewer` agent (Opus) reviews the branch before the pull
  request.

## Testing

Tier 1 per task, the security tests above, `pnpm dev:up` from clean
(proves `server sample-seed` replaces the old walk), the demo layer run
locally with `docker compose ... -f deploy/demo/compose.demo.yml up`
and walked in the browser pane, then tier 3 before the pull request.

## Tasks

| # | Task | Files | Depends | Model |
|---|---|---|---|---|
| 1 | Demo config, locks and fetcher | `config.ts`, `services/demo/**`, `http/fetcher.ts`, `main.ts`, `worker.ts`, `deps.ts` | none | opus (high stakes: auth) |
| 2 | Demo requests: principal, `DEMO_PATHS`, read-only, limit, auth config | `http/demo*.ts`, `services/auth/principal.ts`, `app.ts`, `routes/auth-config.ts`, `http/static.ts` | 1 | opus (high stakes: auth) |
| 3 | `server sample-seed`, dev-stack on it | `services/sample/**`, `server.ts`, `scripts/dev-stack.mjs`, `scripts/sample-book*.mjs` | none | |
| 4 | The web app in demo mode | `apps/web/**` | 2's `demo` field (pinned above) | |
| 5 | `deploy/demo/` and its compose test | `deploy/demo/**`, `apps/api/src/stack/**` | 1, 3 (names pinned above) | |
| 6 | Site link and docs section | `apps/site/**`, `apps/docs/**` | none | inline |
| 7 | Threat model, security review, tier 3, PR | `docs/security/**` | all | inline |
