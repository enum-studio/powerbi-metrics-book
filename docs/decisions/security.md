# Security

Taken in the spec of 2026-10-25 or during the build (2026-10-25 to 2026-10-27), as each says. A
decision that moves a trust boundary also changes `docs/security/threat_model.md`.

## Settings and secrets live in the product

**Every setting and secret is entered in the admin section or the CLI, and an environment variable
of the same name wins. Secrets are write-only and encrypted with age for each container that reads
them. Only a few bootstrap values stay in the environment.** Taken 2026-10-25 (review item 14),
departing from Metrics Book's environment-only contract, which still works for every secret. This
product has more secrets than one with them built into code, and setting up is where people go
wrong, so one UI writes them all. Each container reads only its own: the api can never read the
scanner's secret. The worker rotates its own identity under row-level security: `worker_rw` may
update only `secret_ciphertext` rows with `reader = 'worker'` and insert or update only its own
`container_identity` rows, so a compromised worker cannot overwrite the api's ciphertexts (for
example to forge CSV links by replacing `result_link_key`). The policies are in
`apps/api/src/db/sql/secrets.sql`. Stops being right if a container needs another's secret, which
would be a design change and a threat model change.

## The first run is a one-time setup link, run by a person

**The first admin starts from a link printed by `server setup-link`, which the person runs
themselves. It works once, for 24 hours; a new link ends every earlier link and session.** Taken
2026-10-25 (review item 15): Grafana, Gitea and Jenkins start this way, and it is the only way in
before any sign-in exists. The setup security review added: the setup API is `/api/setup/*` (the
screen is `/setup`); the link puts its token in the fragment, so no proxy log records it; the api
never logs the link, so only someone who can run commands in the container can start the setup;
before the first admin exists the setup session may run only the address and app-registration steps;
it lives at most 12 hours from the link's spend; and the first-admin marker is bound to the holder's
own OAuth `state`, with the holder asked to confirm the admitted email, so a planted cookie from a
sibling subdomain cannot make an attacker the admin. An agent never runs the command: all three
agents' deny rules block `docker compose exec`, and the person's step is stated in each skill.
Accepted: during the 10 minutes of the first admin's sign-in, someone who can send the holder's
browser to Microsoft's callback can expire the marker cookie, so the holder signs in again. Stops
being right if a platform has no way for a person to run a command in the api.

## Four settings are set only in the environment

**`search.base_url`, `powerbi.authority`, `powerbi.api_url` and `powerbi.graph_url` are set only in
the environment by the operator; the store refuses them and ignores a saved row.** An admin who
could set them could point the api at a host of their own, and the api would send the embedding key
or a registration's secret there, which breaks "admins can replace a secret but never read one back".
A sovereign cloud or a proxy is configured in the deployment's `.env`. A security test holds it.
Stops being right if a setting could be limited to an allow-list of hosts.

## A check never repeats the value it checked

**A check result is a fixed sentence of at most 300 characters (a database CHECK) and holds no
piece of the value it checked.** The sentence is what the admin sees and what the docs list in
"When a check fails". A status caller with only `admin:read_status` sees failing check names
without messages, expiring secrets by name and date, and a count of connections to remake. Stops
being right if a check needs to show a hostname back to the admin; that would need its own field.

## Errors log the database's own error, never the query

**One error logger serves routes, MCP tools and Better Auth. A failed query is logged as Postgres's
own error, never its query or parameters.** A Drizzle error message carries the parameters, which
can be ciphertext, PKCE verifiers, key digests and secret ciphertext. Stops being right if a logger
needs the query to debug; log a hash of it.

## Grants, identities and sample values

**`applyGrants` revokes everything from `public`, including execute on routines, so a routine a role
calls needs a declared grant. No directory in the repository is named `identity`. Example
environment files are `env.example`, and a compose file is checked with `--dry-run create`, never
`config`. Production refuses an `AUTH_SECRET` or database password that starts with `SampleOnly`.**
Age identities live in directories named `identity`, so `.gitignore` and the agents' deny rules
treat that name as secret; code about identities is named by what it does (`src/entra/`).
Agents may not read `.env*`, so the example files carry no leading dot. `docker compose config`
prints resolved secrets. Stops being right if the deny rules change their pattern.

## What is not a setting

**The public-paths rule, a credential check on every route, results bound to their owner, the
connector never changing the book, per-container encryption of secrets and tokens, and the security
tests are not settings.** Taken 2026-10-25. They are what makes the product safe to run, so
changing one is a pull request to the core with a security review, as CONTRIBUTING.md says. New
public paths (the SPA shell, each screen's own GET path, `GET /api/auth/config`) are named in the
public-paths list, each with its test line. Stops being right only by a decision of Martin's, written
here with its reason.
