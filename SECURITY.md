# Security policy

Report a vulnerability privately. Do not open a public issue or pull request for it.

## How to report

Open a private report through GitHub security advisories:
https://github.com/enum-studio/powerbi-metrics-book/security/advisories/new

Include:

- what you found and which part it is in (api, worker, CLI, compose, the image)
- the version, or the commit if you built from `main`
- the steps to reproduce it, and what an attacker gains
- whether you plan to publish, and when

Test against your own local stack (`pnpm dev:up`) on the mock tenant. Never test against a deployment you do not run, and never against a real Power BI tenant you do not own.

## What happens next

These are targets, not guarantees. This is a small team.

| Step | Target |
|---|---|
| We confirm we received your report | 3 working days |
| We tell you whether we accept it as a vulnerability | 7 days |
| A fix for a confirmed high-severity issue | 30 days |
| A fix for a confirmed lower-severity issue | the next minor release |

We keep you informed while we work. We fix the issue in private, release a patch version, and publish a GitHub security advisory. We credit you in the advisory unless you ask us not to. Please give us the time above before you publish your own write-up.

## What is in scope

The core, which is this repository and what it releases:

- the api (`apps/api`): sign-in, tokens, the MCP connector, `/api/v1`, the setup link, authorization, the Power BI connection and the tokens it stores, stored results and their CSV links
- the worker (the same image, started with `worker`): the sync, the scanner's secret, result expiry
- how secrets and Power BI tokens are encrypted for each container
- the CLI (`apps/cli`), including how it handles secrets and its stored credentials
- the stack definition: `stack/compose.yml`, the Postgres roles and the container hardening
- the default Cerbos policies the image ships
- the published image and the `powerbi-metrics-book` package on PyPI

[docs/security/threat_model.md](docs/security/threat_model.md) lists who attacks the stack and what each control is for.

## What is not in scope

- **A company's own deployment.** Its access policies, role assignments, sign-in providers, secrets, conventions and hosting belong to that company. Report those to them.
- **Power BI and Microsoft Entra.** A flaw in Power BI, its REST API or Microsoft identity goes to Microsoft. Tell us as well if this product makes it reachable in a way Power BI alone does not.
- **Other people's software.** A flaw in Better Auth, Cerbos, Hono, Postgres, pgvector or another dependency goes to the project that makes it. Tell us as well if our configuration makes it reachable, so we can pin a safe version.
- Findings that need access an attacker already has, such as root on the VM, a container's identity volume, or a Power BI admin account.
- Reports from an automated scanner with no demonstration that the issue can be exploited.

## Supported versions

Only the latest minor release gets security fixes. Until 0.1 is released, only `main` does.

| Version | Supported |
|---|---|
| the latest minor release | yes |
| older releases | no; upgrade to the latest minor |
