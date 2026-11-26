---
title: The evaluator's checklist
description: Fourteen things a company can tick before it runs the stack, each with the test that proves it and a command to check it on your own deployment.
sidebar:
  order: 10
---

This page is for the person deciding whether the stack may run in your company. It lists fourteen controls. Each has a sentence on what it means, the test file and test names that prove it, and a way to check it yourself.

Every file and test name below is checked against the repository on each docs build, so a renamed or deleted test breaks the build instead of leaving a claim with no proof.

## How to check

Each item gives two kinds of check.

- **Run the proof.** The tests run against a real Postgres and a real Cerbos that the test run starts in Docker. Nothing in them is mocked except Microsoft, Power BI and the embedding provider, which are replaced by the repository's own mock.
- **Check your deployment.** Commands for the deployment you run, as a signed-in admin (`pbmb login`). The output shown was taken from the stack on the sample tenant, so the address and the dates in yours will differ.

To run every security test at once, from a checkout of the release you run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @powerbi-metrics-book/api exec vitest run _security_test
```

You should see `Test Files` and `Tests` lines that end in `passed`, and no `failed` or `skipped` count. A skipped test counts as a failure here.

The command `pbmb admin check security` runs the items that can be checked on a live deployment. Each item reports `passing`, `failing` or `explained`, with a sentence. **What to do next** and **Admin > Status** list each item that fails. When nothing fails the command prints the status and exits 0:

```bash
pbmb admin check security
```

```text
 status   passing
 message  -
```

When items fail it prints the count and, under it, the sentence of each failing item, and exits 1. This run was against the api with no app registration step done and no identity volume, so two items fail:

```text
 status   failing
 message  2 of the security checklist's items fail. Each says what to change.
  - The app registration's check has not passed. Finish the app registration step first.
  - IDENTITY_DIR does not exist in the api, so its identity is not kept on a volume.
```

To see every item, passing ones too, ask for JSON. The items are in the field `details.items`:

```bash
pbmb admin check security --json \
  | jq -r '.details.items[] | "\(.status) \(.item): \(.sentence)"'
```

```text
passing https: PUBLIC_BASE_URL is https.
passing cookies_secure: Cookies are Secure, HttpOnly and SameSite=Lax.
explained scanner_secret_worker_only: The scanner's secret is not set yet.
failing app_registration_read_only: The app registration's check has not passed. Finish the app registration step first.
failing identity_volume_private: IDENTITY_DIR does not exist in the api, so its identity is not kept on a volume.
explained worker_identity_volume_private: The api cannot see the worker's volume. In the worker, ls -ld /var/lib/pbmb/identity should show drwx------.
```

The `explained` line is for you to do: run that `ls` in the worker. Over `http` the `https` item says `explained` and `PUBLIC_BASE_URL is http, which only development and test allow.` On a deployment people use, `failing` there means the address is not `https`.

## The items

Items 1 to 12 and item 14 are built and tested. Item 13 is part built, and says what is missing.

### 1. People see only the metadata Power BI lets them reach

**What it means.** If Power BI does not let someone open a dataset, they cannot find its name, tables, measures or DAX here. A dataset they may not see answers exactly like one that does not exist.

**How it works.** The setting `access.metadata_visibility` defaults to `powerbi`. Cerbos decides every request. Lists and search apply the rule inside their SQL, from Cerbos's query plan, so a hidden row is never read and then dropped. The rules are in `access/policies/`.

**Proved by.** The authorization matrix in `apps/api/src/routes/authorization-matrix.ts` names every route and tool and what each kind of caller gets. The test sends a real request for each cell, against the sample tenant.

- [`apps/api/src/routes/authorization_matrix_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/routes/authorization_matrix_security_test.ts): `names every route and tool there is, and none there is not`, `fails on a route registered on the app and missing from the matrix`
- [`apps/api/src/services/access/metadata_visibility_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/access/metadata_visibility_security_test.ts): `answers the outsider's list, dataset and metric exactly like missing ones`
- [`apps/api/src/services/search/search_visibility_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/search/search_visibility_security_test.ts): `gives the outsider no hit from any dataset, and what is in none`

**Check it yourself.**

```bash
pbmb admin settings get access.metadata_visibility
```

```text
 key                   access.metadata_visibility
 value                 powerbi
 source                default
```

`value` should be `powerbi`. `everyone` shows every dataset to every signed-in person, and `policy` leaves the decision to your own Cerbos policies.

Visibility comes from the last sync, so a change in Power BI reaches here after the next incremental scan (workspaces, hourly by default) or full scan (app audiences, daily at 02:30 by default). Power BI itself still decides every query when it runs.

### 2. Queries run as the person, with their row-level security

**What it means.** A DAX query goes to Power BI with the token of the person who asked, so workspace access, app audiences and row-level security apply as they do in Power BI. There is no shared query identity.

**Proved by.**

- [`apps/api/src/services/queries/query_identity_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/queries/query_identity_security_test.ts): `runs with the asking person's own token, whatever another person may reach`, `runs a service account's query as the app, only when an admin allows service-account queries`, `is refused to a service account on a model with row-level security, before any token is fetched`
- [`apps/api/src/services/connection/connection_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/connection/connection_security_test.ts): `leave no token in clear in any column of the person's connection`, `are encrypted for the api's identity alone, which the worker's is not`

**Check it yourself.** The one exception is a service account, which has no person behind it. It queries as the app's own service principal, and only when an admin turns that on. It is off by default:

```bash
pbmb admin settings get powerbi.service_account_queries
```

```text
 key                   powerbi.service_account_queries
 value                 false
 source                default
```

Power BI refuses a service principal any model that has row-level security, and the stack does not try.

### 3. Nobody reads another person's results

**What it means.** A stored query result can be read only by the principal that ran the query. A curator or an admin who asks for it gets the same answer as for a result that does not exist. This is code, not policy, so a changed policy cannot open it.

A CSV link is a signed bearer link for one result. It names the result, the owner and an expiry 15 minutes ahead, signed with a key only the api reads.

**Proved by.**

- [`apps/api/src/services/queries/result_ownership_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/queries/result_ownership_security_test.ts): `is not_found for another person reading it by id`, `is not_found to another person, a curator and an admin, by id and by CSV, while the owner's link is valid`
- [`apps/api/src/services/queries/links_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/queries/links_security_test.ts): `is refused with its id, owner or expiry changed`, `is refused once its 15 minutes are over`
- [`apps/api/src/routes/v1/csv_link_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/routes/v1/csv_link_security_test.ts): `refuses a link for one result on another, even of the same owner`

**Check it yourself.** Results are deleted after `results.ttl_hours`:

```bash
pbmb admin settings get results.ttl_hours
```

```text
 key                   results.ttl_hours
 value                 24
 source                default
```

A result is kept 24 hours by default and 72 at most, because results hold company data. The worker deletes it within 15 minutes of expiry, and the VM backup leaves result rows out. Lower the setting if your policy wants results gone sooner. The query log keeps the DAX of every query and never a row.

### 4. Agents cannot change definitions through the connector

**What it means.** The connector at `/api/mcp` has no tool that edits a metric, variant, term, category or the conventions. Text an attacker plants in Power BI data or in a thread cannot make an agent rewrite a definition through it.

**Proved by.** The test follows every import of the connector's modules with the type checker, and fails when one reaches a function that writes the book.

- [`apps/api/src/mcp/connector_surface_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/mcp/connector_surface_security_test.ts): `are all on the spec's list, each once`, `are allowed only the reads of the book and conventions services`, `are never allowed the result store, the CSV signer or the audit writer`, `finds a write through a module that makes one, so the checks above are not vacuous`

**Check it yourself.** From a checkout, list the tools the connector serves:

```bash
pnpm --filter @powerbi-metrics-book/api exec tsx scripts/dump-mcp-tools.ts | jq -r '.tools[].name'
```

You should see names such as `search`, `list_metrics`, `get_metric` and `execute_dax`, and no name that creates, edits, approves or deletes a metric, term, category or the conventions. A few tools write the caller's own records: thread posts, replies, upvotes and views, the query log and the caller's own results, a CSV link for a result they own, and a daily `connector.whoami` row in `audit_event`. None writes the book. The same list, with each tool's input, is in [the MCP tools reference](/docs/reference/mcp-tools/).

### 5. An agent cannot sign off a metric as a person

**What it means.** The trust state `human_verified` is set only from a person's browser session, under the default conventions. A token from the CLI or an MCP client, and a service account, can reach `agent_verified` and no further. The rules for who may verify (`trust.*` in the conventions) can be changed only from a browser session too.

**Proved by.**

- [`apps/api/src/services/book/approval_browser_only_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/book/approval_browser_only_security_test.ts): `refuses a token under the default conventions, whatever the role and the checks`, `verify gives agent_verified, and a token's change leaves an approval`, `refuses a change to trust.* from a token, and takes the other rules`

**Check it yourself.**

```bash
pbmb conventions export | grep -A2 '^trust:'
```

```text
trust:
  agent_verify_requires: all_checks
  human_verify_from: browser
```

`human_verify_from: browser` is the default and the safe value. A company may change it, which is a decision your admins make with a browser session, and it is recorded.

### 6. Secrets are never shown again, and a database copy holds none in clear

**What it means.** No route, command or log returns a secret's value after it is saved. The admin section and the CLI show whether a secret is set, its last four characters, who set it, when it expires and its last check. A secret is stored encrypted with age, once for each container that reads it, and the keys are not in the database. [How secrets and tokens are stored](/docs/security/secrets-and-tokens/) has the detail.

**Proved by.**

- [`apps/api/src/services/secrets/secret_write_only_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/secret_write_only_security_test.ts): `export no function beyond the ones reviewed here`, `give no value back from the writer, its list or its audit event`, `are refused to a container that does not read them`
- [`apps/api/src/services/secrets/secret_at_rest_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/secret_at_rest_security_test.ts): `never hold the value in a stored ciphertext`, `leave neither a value nor an identity in a dump of every table`

**Check it yourself.**

```bash
pbmb admin secrets list
```

```text
 name                           readers      set    hint  set_by                set_at                    expires_at                check_status
 gemini_api_key                 api, worker  false  -     -                     -                         -                         -
 openai_api_key                 api, worker  false  -     -                     -                         -                         -
 powerbi_app_client_secret      api          true   cret  the setup link        2026-10-26T19:02:34.268Z  2099-12-31T00:00:00.000Z  unchecked
 powerbi_scanner_client_secret  worker       true   cret  admin@sample.example  2026-10-26T19:02:34.445Z  2099-12-31T00:00:00.000Z  unchecked
 result_link_key                api          false  -     -                     -                         -                         -
```

The sample secrets are invented values, which is why `hint` reads `cret` and `expires_at` is far away. `hint` is the last four characters, and there is no column for a value. `pbmb admin secrets --help` lists three commands, `list`, `set` and `expiry`, and none that reads a value back. `pbmb admin secrets set <name>` reads the value from a prompt with no echo and refuses it on the command line, so it cannot land in shell history.

### 7. The internet-facing api cannot read the tenant-wide credential

**What it means.** The scanner's client secret reads every workspace's metadata and DAX in your tenant. It is encrypted for the worker only. Nothing from the internet can connect to the worker, because it is not on the network the proxy reaches. The api can write the secret but cannot read it back, even if it is broken.

**Proved by.**

- [`apps/api/src/services/secrets/scanner_secret_isolation_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/scanner_secret_isolation_security_test.ts): `cannot be read by a reader holding the api's identity`, `is refused to the api even when the api's environment carries it`
- [`apps/api/src/stack/compose_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/stack/compose_security_test.ts): `opens no boundary`. It fails when the api and worker share an identity volume.

**Check it yourself.** In the `pbmb admin secrets list` output above, `powerbi_scanner_client_secret` has the reader `worker` and nothing else. The security check says it in words. Its item `scanner_secret_worker_only` reports `Only the worker can read the scanner's secret.`, as in the list at the top of this page. If the api ever could read it, that item would report `failing` with `The api can read the scanner's secret. Enter it again, so it is encrypted for the worker only.`, and `pbmb admin check security` would exit 1.

### 8. Sign-in is the company's choice

**What it means.** Microsoft is always on. You may add Google, any OpenID Connect provider (Okta, Auth0, Keycloak, a second Entra tenant) and passkeys. Each is a client id and a secret in the admin section. [Sign-in](/docs/security/sign-in/) says what each one needs and what it protects.

**Proved by.**

- [`apps/api/src/services/auth/sign-in-providers.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/sign-in-providers.test.ts): `authorizes at the mock, makes a session and answers /api/v1/me`, `signs in a person a group assignment at that provider reaches`, `exist only once sign_in.passkeys is on, and are registered by people already signed in`
- [`apps/api/src/routes/auth-config_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/routes/auth-config_security_test.ts): `holds no client id, issuer, secret or redirect URI`
- [`apps/api/src/services/auth/dev_sign_in_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/dev_sign_in_security_test.ts): `answers 404 in production even with ALLOW_DEV_SIGN_IN=1`

**Check it yourself.** The sign-in screen asks the api which providers are on. Anyone can read the answer:

```bash
curl -s https://metrics.example.com/api/auth/config
```

```text
{"providers":[{"id":"microsoft","kind":"microsoft","name":"Microsoft"}],"passkeys":false,"dev_sign_in":true,"sample_data":true}
```

On a production deployment `dev_sign_in` is `false`. It is `true` above only because the sample stack runs in development. `sample_data` is `true` above for the same reason: the sample stack runs on the mock tenant, and it is `false` on any real deployment. The answer has no client id, issuer or secret.

### 9. Every access is accountable

**What it means.** Denials, credential changes, admin actions and downloads go to `audit_event`. Every query goes to `query_log`. Every change to the book goes to `book_change`. The database roles the api and worker use while they serve requests, `api_rw`, `worker_rw` and `audit_writer`, can add rows to these tables and cannot update, delete or truncate them.

**What this protects against, and the gap.** The insert-only roles protect the records from a bug or an attack that reaches the api's or worker's request code, such as an injection that runs SQL as `api_rw`: it can add rows and cannot rewrite or remove one. They do not protect the records from a compromised api process. The api container also holds `MIGRATOR_DATABASE_URL`, because the api migrates the database each time it starts (`config.ts`, `main.ts` and `stack/compose.yml`). The `migrator` role owns every table, and an owner can change its tables freely. An attacker who runs code inside the api container can read that variable and connect as `migrator`, and can then rewrite or delete `audit_event`, `query_log` and `book_change`. The worker does not hold the migrator's URL. Moving migrations out of the api would close this. That is a design change for the maintainers and is not part of this release.

**Proved by.** The refusals prove that rows cannot be changed or deleted by the request roles. The insert tests prove that inserts work.

- [`apps/api/src/services/audit/audit_append_only_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/audit/audit_append_only_security_test.ts): `refuses %s an update, a delete and a truncate`, `takes an insert from audit_writer`, `takes an insert from audit_writer, which cannot read it`
- [`apps/api/src/db/schema/book.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/db/schema/book.test.ts): `refuses %s on %s: %s`
- [`apps/api/src/db/grants_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/db/grants_security_test.ts): `gives each role exactly the privileges declared for it`, `makes every role a login and none a superuser`

The first file runs the refusals for both `audit_event` and `query_log`. The second runs them for `book_change`.

**Check it yourself.**

```bash
pbmb admin audit
```

You should see recent rows with the columns `id`, `at`, `principal_id`, `via`, `action`, `resource_kind`, `resource_id` and `decision`. They include your own `pbmb` calls, for example `cli  admin.check.run  check  app_registration  allow`. The rows show that records are written. They do not show that the records are safe from the migrator or from whoever holds the database superuser password. Both can change these tables.

### 10. Only the api is reachable from outside

**What it means.** Only the `api` container publishes a port, and on the loopback address, for the reverse proxy on the same machine. Postgres and Cerbos sit on an internal network with no route out. The worker is never on the network the proxy reaches.

**Proved by.**

- [`apps/api/src/stack/compose_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/stack/compose_security_test.ts): `opens no boundary`, `publishes the api's port on loopback only, for the proxy on the same machine`, `app is not internal`
- [`apps/api/src/http/public-paths_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/http/public-paths_security_test.ts): `answers 401 without a credential on a route registered on the app and not on the public list`, `guards every route that is not public, and only those`

The second file covers what the first cannot: the api's own routes. The public list names what is open and never what is protected, so a route added tomorrow is behind the gate because nobody listed it.

**Check it yourself.** Run both commands in the folder that holds your `compose.yml`:

```bash
docker compose ps --format '{{.Service}}: {{range .Publishers}}{{if .PublishedPort}}{{.URL}}:{{.PublishedPort}} {{end}}{{end}}'
```

```text
api: 127.0.0.1:3000
cerbos:
postgres:
worker:
```

Only `api` has an address. Then check the networks. The name starts with your compose project, which is the folder name unless you set `-p`:

```bash
docker network inspect pbmb_app pbmb_edge pbmb_egress --format '{{.Name}} internal={{.Internal}}'
```

```text
pbmb_app internal=true
pbmb_edge internal=false
pbmb_egress internal=false
```

`app` is internal. Only the api is on `edge`. A request with no credential gets a 401 from every route that is not public:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://metrics.example.com/api/v1/metrics
```

```text
401
```

### 11. The Microsoft permissions are the least that works

**What it means.** This product needs and asks for read-only delegated permissions: `openid`, `profile`, `email`, `offline_access`, Power BI `Dataset.Read.All` and Graph `User.Read`. The scanner registration holds no API permission at all. The setup fails an app registration whose token lacks `Dataset.Read.All`. A registration may hold more, because it may also serve another product. The check then passes and names each extra as not needed, with what a name shows it can do, such as `Tenant.ReadWrite.All`, which can change every workspace. A name does not show every write, and the check reads only tokens for Power BI, so it says nothing of permissions on Microsoft Graph. The product never uses them, but the app can still do what they allow, so you decide whether to remove them.

**How the check works.** It asks Microsoft for a token as the app registration alone, and a `roles` claim in that token, which is how an application permission shows, adds a note. For the delegated permissions it reads the `scope` that Microsoft's token endpoint answered when a person connected Power BI, and notes any scope outside the list above. Called from the setup, it reads the checking admin's connection. The daily run at 03:30 reads every connected person's. So the check can only judge after an admin has connected Power BI, and until then it says `Connect Power BI now, so the check can read what your token allows.`

The check relies on Entra listing in that answer every delegated permission consented for the Power BI resource, not only the ones the request named. That is what lets it name a `Tenant.Read.All` that someone added to the registration later. It is tested against the repository's mock of Entra and has not yet been run against a real tenant. Until it has, also read the permissions in Entra, as described below.

**Proved by.**

- [`apps/api/src/services/setup/app-registration-check.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/setup/app-registration-check.test.ts): `passes the minimum with no note`, `says plainly what a tenant-wide or writing extra can do`, `passes an app registration that holds an application permission, with a note`, `refuses a scanner that holds any API permission`
- [`apps/api/src/services/setup/app_registration_check_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/setup/app_registration_check_security_test.ts): `fails whenever Power BI's Dataset.Read.All is missing, whatever else the token holds`, `repeats no hostile permission name in a sentence, and stays within the stored limit`

**Check it yourself.** The check runs again every day and on demand:

```bash
pbmb admin check app_registration
```

```text
 status   passing
 message  -
```

A `message` other than `-` names what the registration holds beyond the minimum. You can also read the permissions in Entra, under App registrations, API permissions. The six above should be there, each of type Delegated, with admin consent granted. Anything more is not needed by this product.

### 12. Credentials expire and are rotated

**What it means.** An API key lives at most 90 days, and the database refuses a longer one. Entra client secrets expire, and the admin enters the expiry date so the admin section warns 30 days and again 7 days before. A container's identity can be rotated without losing a secret. [How secrets and tokens are stored](/docs/security/secrets-and-tokens/) has the steps.

**Proved by.**

- [`apps/api/src/services/auth/api_key_expiry_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/api_key_expiry_security_test.ts): `refuses a key once it has expired`, `is refused by the database past 90 days, and created_at is the database's to set`, `stops a key older than its account's max_key_age_days once that is lowered`
- [`apps/api/src/services/admin/secret-expiry.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/admin/secret-expiry.test.ts): `lists in adminStatus the secrets expiring within 30 days, urgent within 7`, `warns whoever manages secrets in /api/v1/me, and nobody else`
- [`apps/api/src/services/secrets/rotate.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/rotate.test.ts): `leaves every secret readable with the new identity and none with the old`

**Check it yourself.** Ask for a key that lives longer than 90 days:

```bash
pbmb sa create ci_bot --owner admin@sample.example --role viewer
pbmb sa keys create ci_bot --expires-in-days 120
```

```text
The request is not valid (expires_in_days: Too big: expected number to be <=90).
```

Then delete the test account with `pbmb sa delete ci_bot`. For secrets near their end, `pbmb admin status` lists them under `secrets_expiring`, which is empty (`[]`) when none is within 30 days.

### 13. Dependencies and images are known

**What it means.** Versions are pinned to an exact number and locked. Every image in the `compose.yml` you deploy is pinned by digest. The image this repository builds is signed when it is released, and its software bill of materials (SBOM) and build provenance are inside what is signed.

**Status: part built.** Four things hold today, each by a different mechanism, and only the first is a test:

- The two third-party images (Postgres and Cerbos) are pinned by digest, and `compose_security_test` fails if one is not. That test deliberately exempts the image this repository builds, because `stack/compose.yml` builds it from source.
- The digest of the api and worker image is written into `compose.yml` by `pbmb init`, which refuses an image reference with no digest. The release workflow also checks that the compose file it publishes names the digest it just built.
- Package versions are exact in every `package.json` and locked in `pnpm-lock.yaml` and `uv.lock`. No test enforces that. It is how the files are written today, and you can check it below.
- Signing is built in the release workflow, but no release has happened yet, so there is no signed image to verify until v0.1.0.

The scanner run is not built, see [Not built yet](#not-built-yet).

**How the signing works.** A pushed tag `v*` runs `.github/workflows/release.yml`. The signature is keyless: GitHub's identity token for that run proves who signed, and Sigstore records it, so there is no signing key to store or leak. The image is signed by its digest, not its tag, so a moved tag cannot carry a different image. Two jobs keep the parts apart. The job that builds the image runs third-party build code and cannot ask for a signing identity. The job that signs runs only cosign, installs it, signs, and verifies what it just signed. A release whose signature does not verify never reaches PyPI. The SBOM and the provenance are attached by the build to the image index, and signing the index signs them too. [`docs/decisions/release.md`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/docs/decisions/release.md) gives the reasons.

**Proved by.**

- [`apps/api/src/stack/compose_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/stack/compose_security_test.ts): `opens no boundary`

- [`apps/cli/tests/commands/test_init_check.py`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/cli/tests/commands/test_init_check.py): `test_init_without_a_digest_refuses_and_writes_nothing`

The first test fails when a service other than the built image runs an image not pinned by digest, or any service runs as root, or lacks `no-new-privileges`, dropped capabilities, a read-only root, a memory limit or a health check. The signing has no test file. Its proof is the workflow, `.github/workflows/release.yml`, whose last signing step runs the same `cosign verify` as below and fails the release if it does not pass.

**Check it yourself.**

1. Every image in the `compose.yml` that `pbmb init` wrote is pinned by digest. `pbmb init` takes the api and worker image from the digest bundled with a release. No release exists yet, so today you pass one with `--image`. The digest below is a placeholder of zeros:

   ```bash
   pbmb init ./deployment --public-base-url https://metrics.example.com \
     --image ghcr.io/enum-studio/powerbi-metrics-book:0.1.0@sha256:0000000000000000000000000000000000000000000000000000000000000000
   cd deployment
   grep -E '^ *image: ' compose.yml
   ```

   ```text
     image: &image ghcr.io/enum-studio/powerbi-metrics-book:0.1.0@sha256:0000000000000000000000000000000000000000000000000000000000000000
       image: pgvector/pgvector:pg18-trixie@sha256:ab49524d18df7200b74ac9a475e1db6297fc1eb57da4c214c63d10ecc4b754fa
       image: ghcr.io/cerbos/cerbos:0.57.0@sha256:e5e3b150b3cb0090975605254f255164567d67e233634199fb20972e3eaff300
   ```

   Every line ends in `@sha256:` and a digest. The first line is the image the `api` and `worker` services run, and the other two are Postgres and Cerbos.

   For versions, `grep -rn '"\^\|"~' package.json apps/*/package.json packages/*/package.json` prints nothing, so no dependency uses a `^` or `~` range. The lockfiles are `pnpm-lock.yaml` and `uv.lock` in the repository root.

2. Verify the signature before you deploy. **There is no release yet, so there is nothing to verify until v0.1.0.** Each release's notes on GitHub print this command with the digest, tag and commit filled in. It is shown here with the placeholders left in, as the notes print it:

   ```bash
   cosign verify ghcr.io/enum-studio/powerbi-metrics-book@sha256:<digest> \
     --certificate-identity https://github.com/enum-studio/powerbi-metrics-book/.github/workflows/release.yml@refs/tags/v<version> \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-sha <commit> \
     --certificate-github-workflow-repository enum-studio/powerbi-metrics-book \
     --certificate-github-workflow-trigger push
   ```

   The command passes only if the signature was made by that workflow file, for that tag, at that commit, in that repository, on a tag push. A signature from any other workflow, branch, fork or trigger fails it. It needs the Sigstore public services. On success cosign prints the checks it ran and the signature's JSON. The `<digest>` is the one in the release notes and in the release's `compose.yml`.

### 14. PII needs its role, and off datasets stay hidden

**What it means.** PII stays hidden without `pii_reader`; query checks and a result header
check refuse PII before a result is stored. Off datasets disappear from
ordinary reads and queries, including an admin's, regardless of policy.

**How it works.** Name-based PII rules filter the catalog and query references. Cerbos grants PII reads to `pii_reader`; code refuses service accounts and excludes off datasets regardless of policy.

**Proved by.** Shipped policies refuse PII without its role, and code enforces the dataset switch even under a permissive deployment policy.

- [`apps/api/src/routes/v1/pii_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/routes/v1/pii_security_test.ts): `refuses a PII result header without storing any result`, `refuses a service account even though the override policy allows its PII read`
- [`apps/api/src/routes/v1/dataset_switch_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/routes/v1/dataset_switch_security_test.ts): `keeps an off Certified dataset outside describableDatasets under an override policy`, `refuses queries while off, even for admins, and runs them again when on`

**Check it yourself.**

```bash
pbmb admin pii list
pbmb admin datasets list
```

Review the rules and enabled states. Compare a viewer's column list with that of a person holding `pii_reader`. Turn a test dataset off and confirm it disappears from lists and refuses queries for an admin too. Its earlier query log entries still name it. Turn it on and confirm reads and queries return.

## Also checked

These tests guard the boundaries behind the items above. Each fails if its boundary opens.

- Token audience, expiry, scope and refresh-token reuse. [`apps/api/src/services/auth/oauth_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/oauth_security_test.ts): `refuses a refresh token used twice, and the grant's access token stops working`, `refuses an expired token`
- The guarded fetcher refuses private addresses. [`apps/api/src/http/fetcher_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/http/fetcher_security_test.ts): `refuses a host that resolves to the cloud metadata address before connecting`, `refuses a %i, even to another configured host`
- The embedding key goes to the configured host only. [`apps/api/src/services/search/embedder_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/search/embedder_security_test.ts): `is refused a host outside the fetcher's list, and never sent there`
- The origin check on state-changing requests. [`apps/api/src/http/origin-check_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/http/origin-check_security_test.ts): `exempts the token, registration and device authorization endpoints only`
- The CSP, framing and HSTS headers. [`apps/api/src/http/security-headers_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/http/security-headers_security_test.ts): `are on an answer from the error handler`, `leave out HSTS when the public address is plain http`
- The setup link works once, expires, and is closed after the first admin. [`apps/api/src/services/setup/setup_link_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/setup/setup_link_security_test.ts): `refuses a token the second time it is used`, `closes every setup route once an admin exists, to a stale setup session and to a viewer`
- Sign-in attempts are rate limited. [`apps/api/src/services/auth/rate_limit_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/rate_limit_security_test.ts): `refuses the 61st start from one client within a minute, and counts it in Postgres`

## What this checklist does not cover

These risks stay, and [the threat model](/docs/security/threat-model/) gives the reason for each and what limits it.

- A broken api can query Power BI as any person who has connected, because it holds the key to their tokens. Disconnecting deletes them.
- A broken worker can read every workspace's metadata and DAX, because it holds the scanner's secret.
- Root on the host opens everything, identity volumes included.
- The query log shows every query's DAX to everyone signed in, so agents can reuse DAX that worked. It never holds a row.
- Search sends names, descriptions and term values to the embedding provider, and the text of each search. `search.provider: none` turns that off. [What leaves the stack](/docs/security/what-leaves-the-stack/) lists it all.
- Behind a reverse proxy, set `TRUSTED_PROXY`, or every sign-in attempt counts against the proxy's one address. On a platform whose edge sets `X-Real-IP` and publishes no proxy range, `CLIENT_ADDRESS_HEADER=x-real-ip` counts the one address in that header instead, but only if the edge replaces a client-sent `X-Real-IP`, which Railway's [networking page](https://docs.railway.com/networking/public-networking/specs-and-limits) does not say. Before relying on it, call `GET /api/v1/me` with a spoofed `X-Real-IP` and confirm `client_address` shows your real address. Any route to the api past the edge (Railway's private network, a TCP Proxy) defeats it, and Caddy and Traefik as configured here pass the header through, so never use it behind them.

## Not built yet

The spec lists these. They are not done today, so this page does not claim them.

- `pnpm check:all` and the scanners it runs (gitleaks, osv-scanner, trivy, zizmor, and semgrep over the whole tree). What exists is the secret-scan configuration in `.gitleaks.toml`, the repository's two semgrep rules in `.semgrep/rules/` (no `fetch` outside the guarded fetcher, no SQL built from strings) and the merge gate in `.github/workflows/merge-gate.yml`, which runs formatting, lint, types and the migration check.
- A release that has happened. Signing and the SBOM are built, but they run only on a release tag, and none has been pushed. The first is v0.1.0.
- Backups. The containers take none. [How secrets and tokens are stored](/docs/security/secrets-and-tokens/) says how to back up the identity volumes apart from a database dump.
