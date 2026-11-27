# Power BI Metrics Book

Power BI Metrics Book is Agent First BI: a metrics book over a company's own Power BI, so its AI agents get the right numbers. It mirrors your workspaces, datasets and measures, keeps one definition per metric, and serves both to Claude (or any MCP client) through an MCP connector, the `pbmb` command and a REST API, with every query run under the asking person's own Power BI rights.

You run it yourself as four containers, open source, and point it at your Power BI tenant. It is the sister product of [Metrics Book](https://github.com/enum-studio/metrics-book) (coming soon), and the two share one look and one set of words.

**Current version: 0.1.1.** The app and source are available. See the [changelog](https://github.com/enum-studio/powerbi-metrics-book/blob/main/CHANGELOG.md) for what is included. To develop against the mock tenant, follow [CONTRIBUTING.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/CONTRIBUTING.md).

## Agent First BI

The main user of deep analytics is now an agent, and people work through it. Someone asks Claude or Codex a question; the agent finds the right metric, writes the DAX, gets the numbers and brings back the answer. Power BI Metrics Book gives that agent a good way into the Power BI setup you already have:

- Power BI stays the single source of truth. Nothing moves out of it, and every query runs with the asking person's own Power BI rights.
- A metric is one business concept, and each Power BI measure that calculates it is a variant of it, whichever dataset it lives in.
- The agent finds metrics, columns and terms by meaning, through search over the metadata, and takes the variant's DAX instead of writing it from memory.
- Results stay out of the agent's context. A query answers with a short preview, pages to read on, and a link that downloads every row as a CSV into the agent's working folder.

## What it costs

There is no model inside the product. The agent you already pay for does the thinking, on your existing Claude or ChatGPT subscription. The only model calls are embeddings for search, with your own OpenAI or Gemini key, or none at all: at the prices read on 25 October 2026, embedding 5,000 search documents costs about $0.10 with OpenAI, and later syncs embed only what changed. Beyond that you pay for the [machine it runs on](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/index.md).

## Who it is for

- **A company that already runs Power BI** and wants its agents to answer with the company's own definitions, not a guess at which measure is "revenue".
- **The person who sets it up**, usually a Power BI admin or an engineer next to one. You need the right to register apps in Microsoft Entra and to change Power BI tenant settings. The setup guide walks through every click.
- **The agents that connect**, such as Claude, Codex and Cursor. The docs are written so an agent can follow them step by step.

It serves one organisation and one Power BI tenant per deployment. It reads Power BI and never changes a model, a report or a permission.

## The stack

<img src="https://github.com/enum-studio/powerbi-metrics-book/raw/refs/heads/main/apps/docs/public/stack.svg" alt="People and agents reach the api. The api talks to Postgres, Cerbos, Power BI (or the mock) and the embedding provider. The worker talks to Postgres, Power BI's admin scanner and the embedding provider.">

Only `api` takes requests from outside. The same drawing, with the networks, is on [the stack page](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/how-it-works/the-stack.mdx).

## Quickstart

To run the current source against the sample tenant, follow [CONTRIBUTING.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/CONTRIBUTING.md).

You need [uv](https://docs.astral.sh/uv/) and Docker with Compose. The CLI is distributed through PyPI and pins the matching image on GHCR.

```bash
uv tool install powerbi-metrics-book
pbmb init ./deployment --public-base-url https://metrics.example.com
cd ./deployment && docker compose up -d
```

Then run `docker compose exec api server setup-link` yourself (an agent never does) and open the setup link it prints. The link works once, for 24 hours. [The quickstart](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/start/quickstart.md) has the checks that show the stack is healthy.

## The setup in ten steps

The link opens a guide that checks every step with a real call before the next. These pages say the same, step by step, in the product's words.

1. [Address](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/address.md): the https address people open.
2. [The app registration](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/app-registration.md): sign-in and the Power BI connection, in Entra.
3. [The scanner](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/scanner.md): a second registration, its security group and the Power BI tenant settings.
4. [What to sync](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/what-to-sync.md): which workspaces, and when.
5. [Sign-in](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/sign-in.md): Google, OpenID Connect and passkeys beside Microsoft.
6. [Who gets in](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/who-gets-in.md): roles, and who sees which dataset.
7. [Search](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/search.md): OpenAI, Gemini or none.
8. [Agents](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/agents.md): the MCP address and the command line.
9. [First sync](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/first-sync.md): read the tenant for the first time.
10. [Security](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/security.md): the checklist, run against your deployment.

When a check fails, [When a check fails](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/when-a-check-fails.md) has every sentence a check shows, with its cause and fix.

## Where to run it

Each guide ends with `pbmb admin status` passing against the new address. Dokploy, Railway and Azure have not been followed on a real account yet; their pages say so. The VM guide has been followed.

- [One VM with Docker Compose](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/vm.md): the reference deployment, with Caddy for TLS.
- [Dokploy or Coolify on a VM](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/dokploy.md): the same compose file, with the domain and certificate from Dokploy.
- [Railway](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/railway.md): a service per container, with no server to look after.
- [Azure Container Apps](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/azure.md): for a company that already runs Power BI in Azure.
- [Kubernetes](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/deploy/kubernetes.md): no chart yet; the page lists what the containers already meet.

## What agents get

- **The MCP connector.** Search the book, read a metric and its variants, run DAX, read a big result page by page or as a CSV file, ask a question. It never changes the book. See [the MCP tools](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/reference/mcp-tools.md).
- **The `pbmb` command.** Everything the connector does, plus curation: structuring drafts, conventions, roles and keys. See [the CLI](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/reference/cli.md).
- **Five skills** in [skills/](https://github.com/enum-studio/powerbi-metrics-book/blob/main/skills/), as a Claude Code plugin (`.claude-plugin/`) and for Codex and Cursor (`.agents/skills/`): `deploy_powerbi_metrics_book`, `adapt_conventions`, `curate_metrics_book`, `query_power_bi` and `answer_questions`. [Agents](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/set-up/agents.md#skills) has the commands that install them.
- **A REST API** with service-account keys, typed from [its OpenAPI file](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/reference/rest-api.md), to build your own tools.

The company decides the rules: names, the description shape, who may do what and how people sign in are [conventions and settings](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/make-it-yours/index.md), changed without a fork.

## Security in five lines

1. A person sees only the metadata Power BI lets them reach, and a query runs with that person's own token, so row-level security holds.
2. Only the `api` is reachable from outside, and it cannot read the tenant-wide scanner credential.
3. Secrets are entered once, encrypted for the container that reads them, and never shown again.
4. An agent cannot sign off a metric as a person, and the connector cannot change a definition.
5. Every access is audited, and twelve of the thirteen controls on the checklist are built and tested, each with a command you can run. The thirteenth, dependencies and images, is partly built, and the checklist says what is missing.

The evaluator's page is [the security overview](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/security/index.md), with [the checklist](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/security/checklist.md). The model behind it is [docs/security/threat_model.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/docs/security/threat_model.md). Report a vulnerability privately, as [SECURITY.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/SECURITY.md) says.

## Documentation

- [docs/specs/2026-10-25-powerbi-metrics-book.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/docs/specs/2026-10-25-powerbi-metrics-book.md): the design, with the reasons.
- [docs/decisions/](https://github.com/enum-studio/powerbi-metrics-book/blob/main/docs/decisions/): one file per part, with each decision and when it stops being right.
- [docs/standards/](https://github.com/enum-studio/powerbi-metrics-book/blob/main/docs/standards/): naming, TypeScript and Python.
- [AGENTS.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/AGENTS.md): the rules, the layout and how to check a change, for agents and people.
- The docs site starts at [what it is](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/docs/src/content/docs/start/index.md) and is served at `/docs` by a running stack.

## Contributing

Read [CONTRIBUTING.md](https://github.com/enum-studio/powerbi-metrics-book/blob/main/CONTRIBUTING.md) before you open a pull request. Everyone taking part follows the [Code of Conduct](https://github.com/enum-studio/powerbi-metrics-book/blob/main/CODE_OF_CONDUCT.md).

## Licence

Apache-2.0. See [LICENSE](https://github.com/enum-studio/powerbi-metrics-book/blob/main/LICENSE) and [NOTICE](https://github.com/enum-studio/powerbi-metrics-book/blob/main/NOTICE).

Built and maintained by [Enum Studio](https://enumstudio.com).
