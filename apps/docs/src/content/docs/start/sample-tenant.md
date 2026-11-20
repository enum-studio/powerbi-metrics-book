---
title: Try it on the sample tenant
description: Run the stack on an invented Power BI tenant before you can connect your own, then move to your own tenant without any sample data left behind.
sidebar:
  order: 4
---

The sample tenant is a pretend Power BI tenant that the stack can connect to in place of Microsoft's. Everything in it is invented. You can run the whole stack on it in a few minutes, with no Entra app registrations and no admin rights, and move to your own tenant when you are ready.

## When to use the sample, and when your own tenant

Use the sample for the time before you can connect your tenant. Connecting takes two Entra app registrations, admin consent and a Power BI tenant setting. In most companies that means waiting on someone else for days.

Until then, the sample answers the questions that decide whether to ask:

- What an agent sees over MCP.
- How drafts become metrics with variants.
- How a query hands back a preview and a CSV link.

Your own tenant is for use. Nothing you learn on the sample carries over except what you write down: conventions, policies and settings. [Move to your own tenant](#move-to-your-own-tenant) below says how.

## Look around the demo first

[The demo](https://demo.powerbimetricsbook.io) is the web app and these docs on the sample tenant, with no sign-up. Browse the metrics, their variants, the datasets and the terms, and search them. The demo is read-only: you can't sign in, connect an agent or run a query there. To do that, run the sample on your own machine, as below.

## Run it

You need a checkout of the repository and Docker Engine 28 or newer. The mock tenant is not released as an image, so the sample builds it, and the product, from your checkout. The first start takes a few minutes.

```bash
git clone https://github.com/enum-studio/powerbi-metrics-book.git
cd powerbi-metrics-book/examples/sample
cp env.example .env && chmod 600 .env
GIT_SHA=$(git rev-parse HEAD) docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml up -d --build --wait
docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml exec api server setup-link
```

Open the link the last command prints. It works once, for 24 hours. The stack listens on `http://localhost:3000` and the mock on `http://powerbi-mock.localhost:3001`.

The setup asks for the tenant's registrations. The mock's are:

| Setup field | Value |
|---|---|
| Tenant id | `11111111-1111-4111-8111-111111111111` |
| App registration: client id, secret | `c1000000-0000-4000-8000-000000000002`, `sample-app-secret` |
| Scanner: client id, secret | `c1000000-0000-4000-8000-000000000001`, `sample-scanner-secret` |

Sign in as `admin@sample.example` to become the first admin. The Set up part has a page for each step, in the same order as the setup.

## What is in it

Three datasets hold the same net sales under three names, each on a table called Sales lines:

| Dataset | Workspace | The net sales measure |
|---|---|---|
| Sales | Commercial | `Net sales` |
| Finance | Management | `Revenue` |
| Marketing | Growth | `Net Sales` |

That is what the sync works on. It finds one calculation under three names. Sales and Marketing share a name, so they become one draft, `net_sales`. Finance's `Revenue` becomes a draft of its own, because a reader of Finance alone must not learn a name from a dataset they cannot see, and the drafts queue offers the two as a merge. A fourth dataset, Campaign archive, has no tables on purpose, so you can see a dataset whose schema cannot be read.

The sample also has eight people, each with different rights to the three datasets: `admin@sample.example`, `analyst@sample.example`, `viewer@sample.example`, `leader@sample.example` and four more. Sign in as the analyst to see a query run under someone who can reach Sales in full and Marketing in part. [The mock's README](https://github.com/enum-studio/powerbi-metrics-book/blob/main/packages/powerbi-mock/src/sample/README.md) has the table of who reaches what.

Everything is invented, and the stack says so in three places. The SPA shows a "Sample data" band. `pbmb whoami` ends with a `Tenant` line. The MCP connector's instructions open with a paragraph telling the agent that every name and number is sample data, and its `whoami` tool answers `sample_data: true`. Names in the sample are plain, so a command written here runs as it is:

```bash
pbmb datasets list
pbmb datasets show Sales
```

## Move to your own tenant

A database belongs to one tenant, for life. The sample runs as its own Compose project, `powerbi-metrics-book-sample`, with its own database. So moving to your own tenant is deleting the sample and starting your own on a new database. Nothing from the sample is left in it.

In the folder you started the sample from, delete the sample:

```bash
docker compose -p powerbi-metrics-book-sample -f compose.yml -f compose.mock.yml down --volumes
```

The `-p` names the sample's project, so this deletes the sample's containers and volumes and nothing else, whatever `COMPOSE_PROJECT_NAME` or `-p` your own deployment uses. Keep the `-p` on every sample command: without it, a `COMPOSE_PROJECT_NAME` in the shell or in `.env` would name the project instead, and `down --volumes` would delete that project's database. Then, in your own deployment directory, start your tenant on a new database and print the link that opens its setup:

```bash
docker compose up -d
docker compose exec api server setup-link
```

Your deployment directory is the one `pbmb init` writes, as in the [Quickstart](/docs/start/quickstart/). If you laid `compose.mock.yml` over it to try the sample, it is the same folder, and all three commands run there. Follow the [Set up](/docs/set-up/) part from there with your own tenant's values, starting with the [app registrations](/docs/set-up/app-registration/).

### What is kept

The deployment directory stays: `compose.yml`, `.env`, `access/` with its policies and tests, and `book.yml`. Check what you wrote there while trying the sample: a policy test written against the sample names its people, so search `access/tests/` for `@sample.example` and rewrite those tests for your own people.

### Conventions you tuned on the sample

Export them while the sample still runs, to a file of their own, then clean it:

```bash
pbmb admin export -o sample-book.yml
```

Open `sample-book.yml` and delete:

- the `role_assignments` and `service_accounts` sections, which name the sample's people;
- the settings `powerbi.tenant_id`, `powerbi.app_client_id` and `powerbi.scanner_client_id`, which name the sample's tenant and registrations;
- the settings `search.provider` and `search.model`, which the setup set for the mock's embeddings;
- any workspace ids, such as in `powerbi.sync.workspaces.include` and `powerbi.sync.workspaces.exclude`, which name the sample's workspaces.

The export also wrote `conventions.yml` beside `sample-book.yml`. Keep both files together. What is left in `sample-book.yml` is the settings you chose, such as schedules and limits. After the new stack's setup, apply it:

```bash
pbmb admin import sample-book.yml
```

It shows what would change and asks before it does.

### If a database is reused

If you point the stack at your own tenant but keep the sample's database, the api and the worker refuse to start. The api's log says:

> This database belongs to the sample tenant, and the stack now points at Microsoft identity at login.microsoftonline.com.

and ends with a link to this section. The fix is a new database. The sample's database is in whichever Compose project the stack ran under, so take that project down with `--volumes`, using the `-p` and files you started it with, after checking that the project holds only the sample. Then start your own tenant as above. A database that has held one tenant never holds another, and no setting changes that.

The reverse is refused too. A database that has held your tenant does not start on the mock, so the sample never runs over a real tenant's data.

A sample started before it had its own Compose project name ran under its folder's name, `sample`, from `examples/sample`. Its volumes are not part of the new project. From that same folder, list them with `docker volume ls --filter label=com.docker.compose.project=sample`. After checking they hold only the sample, remove them with `docker compose -p sample -f compose.yml -f compose.mock.yml down --volumes`.

## Check

Before you move on, the sample should show these:

```bash
pbmb whoami
```

The last line is `Tenant  the sample tenant: invented data, not your company's`. After the move, `pbmb whoami` shows no `Tenant` line, and the band is gone from every screen.
