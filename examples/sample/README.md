# The sample deployment

A complete deployment directory, on the invented sample tenant that the Power BI mock serves. Development and the end-to-end test run on it, and it shows what a company keeps in git.

## Run it

From this folder, in a checkout of the repository, with Docker Engine 28 or newer:

```bash
cp env.example .env && chmod 600 .env
GIT_SHA=$(git rev-parse HEAD) docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml up -d --build --wait
docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml exec api server setup-link
```

Open the link the last command prints. It works once, for 24 hours. The setup asks for the tenant's registrations; the mock's are:

| Setup field | Value |
|---|---|
| Tenant id | `11111111-1111-4111-8111-111111111111` |
| App registration: client id, secret | `c1000000-0000-4000-8000-000000000002`, `sample-app-secret` |
| Scanner: client id, secret | `c1000000-0000-4000-8000-000000000001`, `sample-scanner-secret` |

Sign in as `admin@sample.example` to become the first admin. The other sample people are listed in `packages/powerbi-mock/src/sample/README.md`.

The first `up` builds two images from this checkout, the product and the mock, which takes a few minutes. The stack listens on `http://localhost:3000` and the mock on `http://powerbi-mock.localhost:3001`.

Stop it and delete its data with:

```bash
docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml down --volumes
```

## Move to your own tenant

The sample runs as its own Compose project, `powerbi-metrics-book-sample`, with its own database, and a database keeps one tenant. Delete the sample with the command above and start your own on a new database. [Try it on the sample tenant](../../apps/docs/src/content/docs/start/sample-tenant.md#move-to-your-own-tenant) has the steps, what is kept and how to bring your conventions across.

## What is here

| File | What |
|---|---|
| `compose.yml`, `cerbos/`, `postgres/`, `AGENTS.md`, `.gitignore`, the two `README.md` files in `access/` | what `pbmb init` writes, unchanged |
| `env.example` | the bootstrap values, filled in for the sample only. A real deployment gets new random ones from `pbmb init`. The name has no leading dot so that agents, which may not read `.env` files, can read and write it |
| `compose.mock.yml` | the mock as the tenant, and the product image built from this checkout |
| `book.yml` | settings changed from the defaults, as `pbmb admin export` writes them |
| `conventions.yml` | conventions changed from the defaults, as `pbmb admin export` writes them |
| `access/policies/query_log.yaml` | the company's own Cerbos rule: a viewer reads only their own query log entries |
| `access/tests/query_log_test.yaml` | its test, which `pbmb check` runs |

`compose.yml` pins the release image `ghcr.io/enum-studio/powerbi-metrics-book:0.1.0` by digest. Until that release exists, its digest is all zeros, and `compose.mock.yml` runs the image built from the checkout instead.

## Check it

```bash
cp env.example .env && chmod 600 .env
pbmb check .
```

`pbmb check` validates `book.yml`, checks `.env`, and runs the policy test in the pinned Cerbos image. `deploy/check.sh` runs the same check on a copy of this folder.
