---
title: "Settings and secrets"
description: "Every setting with its default and environment variable, and every secret with who reads it."
sidebar:
  order: 10
---

<!-- Generated from the settings registry (apps/api/scripts/dump-settings.ts) by scripts/gen-reference.mjs. Do not edit; change the code and run: pnpm --filter @powerbi-metrics-book/docs gen:reference -->

Every setting has three ways in: the admin section, `pbmb admin settings get|set`, and an environment variable. The environment variable wins, and the admin section shows the setting as set by the environment. A key's variable is the key in upper case with each dot as an underscore, so `powerbi.tenant_id` is `POWERBI_TENANT_ID`.

Saving a setting checks it against the schema shown as Accepts.

## `questions`

### `questions.enabled`

Let people and agents ask questions about metrics, datasets and terms, reply, and accept an answer.

- Default: `false`
- Environment variable: `QUESTIONS_ENABLED`
- Accepts: true or false

## `usage`

### `usage.capture`

Record searches and requests made through the connector, the CLI and the API, so curators can see what the book is missing.

- Default: `true`
- Environment variable: `USAGE_CAPTURE`
- Accepts: true or false

### `usage.retention_days`

How many days searches and requests are kept.

- Default: `180`
- Environment variable: `USAGE_RETENTION_DAYS`
- Accepts: a whole number, at least 1 and at most 365

## `powerbi`

### `powerbi.tenant_id`

The Microsoft Entra tenant that owns the Power BI data.

- Default: `null`
- Environment variable: `POWERBI_TENANT_ID`
- Accepts: a GUID or null

### `powerbi.app_client_id`

The client id of the app registration that signs people in and holds their Power BI connections.

- Default: `null`
- Environment variable: `POWERBI_APP_CLIENT_ID`
- Accepts: a GUID or null

### `powerbi.scanner_client_id`

The client id of the scanner's app registration, which reads every workspace's metadata.

- Default: `null`
- Environment variable: `POWERBI_SCANNER_CLIENT_ID`
- Accepts: a GUID or null

### `powerbi.authority`

Where Microsoft identity answers: the public cloud, another cloud, or the mock.

- Default: `"https://login.microsoftonline.com"`
- Environment variable: `POWERBI_AUTHORITY`
- Accepts: text (uri)
- Set only in the environment. No admin can set it, because it says where a secret is sent.

### `powerbi.api_url`

The Power BI REST API's address.

- Default: `"https://api.powerbi.com"`
- Environment variable: `POWERBI_API_URL`
- Accepts: text (uri)
- Set only in the environment. No admin can set it, because it says where a secret is sent.

### `powerbi.graph_url`

The Microsoft Graph API's address.

- Default: `"https://graph.microsoft.com"`
- Environment variable: `POWERBI_GRAPH_URL`
- Accepts: text (uri)
- Set only in the environment. No admin can set it, because it says where a secret is sent.

### `powerbi.sync.schedule`

When the incremental scan runs, as a cron line.

- Default: `"0 * * * *"`
- Environment variable: `POWERBI_SYNC_SCHEDULE`
- Accepts: text

### `powerbi.sync.full_scan_schedule`

When the full scan runs, as a cron line.

- Default: `"30 2 * * *"`
- Environment variable: `POWERBI_SYNC_FULL_SCAN_SCHEDULE`
- Accepts: text

### `powerbi.sync.workspaces.include`

The workspaces to sync: "all", or a list of workspace ids, where an empty list syncs none.

- Default: `"all"`
- Environment variable: `POWERBI_SYNC_WORKSPACES_INCLUDE`
- Accepts: "all" or a list of a GUID

### `powerbi.sync.workspaces.exclude`

Workspace ids the sync skips even when they are included.

- Default: `[]`
- Environment variable: `POWERBI_SYNC_WORKSPACES_EXCLUDE`
- Accepts: a list of a GUID

### `powerbi.sync.workspaces.personal`

Whether the sync reads people's personal workspaces.

- Default: `false`
- Environment variable: `POWERBI_SYNC_WORKSPACES_PERSONAL`
- Accepts: true or false

### `powerbi.datasets.new`

Whether a dataset the sync finds for the first time starts on or off.

- Default: `"on"`
- Environment variable: `POWERBI_DATASETS_NEW`
- Accepts: one of "on", "off"

### `powerbi.service_account_queries`

Whether service accounts may run queries, as the app's own service principal.

- Default: `false`
- Environment variable: `POWERBI_SERVICE_ACCOUNT_QUERIES`
- Accepts: true or false

### `powerbi.connection_requires_matching_email`

Require the person's recorded Microsoft account, or their verified email if none, and allow each account to connect to only one person.

- Default: `false`
- Environment variable: `POWERBI_CONNECTION_REQUIRES_MATCHING_EMAIL`
- Accepts: true or false

### `powerbi.keep_connections_alive_days`

Refresh a Power BI connection idle this many days so it never expires; empty leaves them to expire.

- Default: `null`
- Environment variable: `POWERBI_KEEP_CONNECTIONS_ALIVE_DAYS`
- Accepts: a whole number, above 0 and at most 9007199254740991 or null

## `access`

### `access.metadata_visibility`

Who may see a dataset's description: those Power BI lets read it, everyone, or whoever the policy says.

- Default: `"powerbi"`
- Environment variable: `ACCESS_METADATA_VISIBILITY`
- Accepts: one of "powerbi", "everyone", "policy"

### `access.default_role`

Who gets in with no assignment: none lets in only invited and assigned people; viewer or curator lets in everyone in the tenant with that role. Setup stores none on a new deployment.

- Default: `"viewer"`
- Environment variable: `ACCESS_DEFAULT_ROLE`
- Accepts: one of "none", "viewer", "curator"

## `sign_in`

### `sign_in.email_password`

Allow invited people to sign in with a password.

- Default: `false`
- Environment variable: `SIGN_IN_EMAIL_PASSWORD`
- Accepts: true or false

### `sign_in.providers`

The sign-in providers turned on besides Microsoft, each with its client id and issuer.

- Default: `[]`
- Environment variable: `SIGN_IN_PROVIDERS`
- Accepts: a list of an object

### `sign_in.passkeys`

Whether people may sign in with a passkey.

- Default: `false`
- Environment variable: `SIGN_IN_PASSKEYS`
- Accepts: true or false

## `email`

### `email.from`

The verified Resend sender address.

- Default: `null`
- Environment variable: `EMAIL_FROM`
- Accepts: text (email) or null

### `email.base_url`

Where Resend receives email requests.

- Default: `"https://api.resend.com"`
- Environment variable: `EMAIL_BASE_URL`
- Accepts: text (uri)
- Set only in the environment. No admin can set it, because it says where a secret is sent.

## `branding`

### `branding.name`

The name shown on sign-in, invites and the app header instead of Power BI Metrics Book.

- Default: `null`
- Environment variable: `BRANDING_NAME`
- Accepts: text or null

### `branding.company`

The company's name, shown on the sign-in page.

- Default: `null`
- Environment variable: `BRANDING_COMPANY`
- Accepts: text or null

## `search`

### `search.provider`

The embedding provider behind search by meaning, or none.

- Default: `"none"`
- Environment variable: `SEARCH_PROVIDER`
- Accepts: one of "openai", "gemini", "none"

### `search.model`

The embedding model the provider is asked for.

- Default: `null`
- Environment variable: `SEARCH_MODEL`
- Accepts: text or null

### `search.base_url`

The embedding provider's address; empty uses the provider's own.

- Default: `null`
- Environment variable: `SEARCH_BASE_URL`
- Accepts: text (uri) or null
- Set only in the environment. No admin can set it, because it says where a secret is sent.

## `results`

### `results.ttl_hours`

How many hours a stored query result is kept. Results are kept at most 72 hours, because they hold company data.

- Default: `24`
- Environment variable: `RESULTS_TTL_HOURS`
- Accepts: a whole number, above 0 and at most 72

### `results.preview_rows`

How many rows a query answers with before the full result.

- Default: `20`
- Environment variable: `RESULTS_PREVIEW_ROWS`
- Accepts: a whole number, above 0 and at most 9007199254740991

### `results.page_rows_max`

The most rows one page of a stored result returns, at most 500.

- Default: `500`
- Environment variable: `RESULTS_PAGE_ROWS_MAX`
- Accepts: a whole number, above 0 and at most 500

### `results.daily_row_budget`

The most rows one person's queries may store in a day.

- Default: `1000000`
- Environment variable: `RESULTS_DAILY_ROW_BUDGET`
- Accepts: a whole number, above 0 and at most 9007199254740991

## `queries`

### `queries.rate_per_minute`

The most queries one principal may run in a minute.

- Default: `60`
- Environment variable: `QUERIES_RATE_PER_MINUTE`
- Accepts: a whole number, above 0 and at most 9007199254740991

## `service_accounts`

### `service_accounts.rate_per_minute`

The most requests one service account may make to /api/v1 in a minute.

- Default: `60`
- Environment variable: `SERVICE_ACCOUNTS_RATE_PER_MINUTE`
- Accepts: a whole number, above 0 and at most 9007199254740991

## `setup`

### `setup.completed_steps`

The setup steps that have passed their check.

- Default: `[]`
- Environment variable: `SETUP_COMPLETED_STEPS`
- Accepts: a list of text

### `setup.completed_at`

When setup finished; empty while it has not.

- Default: `null`
- Environment variable: `SETUP_COMPLETED_AT`
- Accepts: text (date-time) or null

## Client address

Two environment variables, not settings, decide which address a request counts against. `TRUSTED_PROXY` is an IP address or CIDR range (not /0), a range written by its network address, such as `10.0.1.0/24`: the api refuses to start with `10.0.1.25/24`, which would trust the whole range. Only a connection from it may name the client in `X-Forwarded-For`; when the header comes from any other connection, the api logs a line for that connection's address at most once a minute, so a proxy whose address changed shows in the log. Any connection can send the header, so look the proxy's address up rather than setting one from the log. An IPv6 range that holds all of `::ffff:0:0/96`, such as `::/64`, is refused like /0. `CLIENT_ADDRESS_HEADER` is `x-forwarded-for` (the default) or `x-real-ip`.

With `x-real-ip` the api takes the client from that header alone: one value that must be an IP address, else the connection's own address counts. It ignores `X-Forwarded-For` and needs no proxy range, but it is safe only if every request comes through an edge that replaces an `X-Real-IP` the client sent. Railway's [networking page](https://docs.railway.com/networking/public-networking/specs-and-limits) documents that its edge sets the header and does not say it replaces one the client sent, so that is unconfirmed. Before relying on the mode, run `curl -H 'X-Real-IP: 192.0.2.1' -H 'Authorization: Bearer <cli token>' https://<domain>/api/v1/me`. The mode is safe only if `client_address` shows your real address, not 192.0.2.1.

Anything that reaches the api without the edge defeats the mode: Railway's private network from other services, and a TCP Proxy. It is never safe behind Caddy or Traefik as configured here, because they pass a client's `X-Real-IP` through. The api refuses to start with both variables set, and refuses `source_cidrs` on a service account under `x-real-ip`.

## Secrets

A secret is write-only: once saved, nothing returns its value. Set one with `pbmb admin secrets set <name>`, which asks without echoing, or with the environment variable of the same name in upper case. Each secret is encrypted to the containers that read it, and only to them.

| Secret | Environment variable | Read by |
| --- | --- | --- |
| `powerbi_app_client_secret` | `POWERBI_APP_CLIENT_SECRET` | api |
| `powerbi_scanner_client_secret` | `POWERBI_SCANNER_CLIENT_SECRET` | worker |
| `result_link_key` | `RESULT_LINK_KEY` | api |
| `resend_api_key` | `RESEND_API_KEY` | api |
| `openai_api_key` | `OPENAI_API_KEY` | api, worker |
| `gemini_api_key` | `GEMINI_API_KEY` | api, worker |
| `sign_in_<provider>_client_secret` | `SIGN_IN_<PROVIDER>_CLIENT_SECRET` | api |
