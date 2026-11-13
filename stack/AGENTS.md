# stack

How the stack runs: `compose.yml` and everything the containers start
from. `stack/compose.yml` is the definition every deployment's
`compose.yml` is generated from, so a mistake here ships to every company.

Security: `docs/security/threat_model.md`. Every change to compose, a
Dockerfile or `postgres/` is a sensitive path and gets the security review
in `docs/security/agents.md`, rule 3.

## What is here

- `compose.yml`: the services `api`, `worker`, `postgres` and `cerbos`,
  their networks and volumes.
- `dev/compose.dev.yml`: adds `powerbi-mock`, turns on the dev sign-in and
  points the Power BI, identity, Graph and embedding settings at the mock.
  Ports and the project name come from a hash of the checkout's path.
- `postgres/init/`: the server's first-start scripts, which create the
  `powerbi_metrics_book` database, the `vector` extension and the roles
  `migrator`, `api_rw`, `worker_rw` and `audit_writer`.
- `cerbos/`: Cerbos's own config. The default policies live in `access/`
  and ship in the image; a deployment's `access/policies/` adds to them.
- `agent_evals/`: the skills' eval tasks and their checks.

## Networks

| Network | Internal | Who |
|---|---|---|
| `edge` | no | the proxy and `api` |
| `app` | yes | `api`, `worker`, `cerbos`, `postgres` |
| `egress` | no | `api` (sign-in, Power BI queries, query embeddings) and `worker` (the scanner, document embeddings) |

`cerbos` and `postgres` are on `app` only, so they have no route out. Only
`api` publishes a port. In development the mock joins `egress` only,
under the name the settings point at, and publishes its own port on
127.0.0.1 for the browser's sign-in.

## Volumes

| Volume | Mounted by |
|---|---|
| `pgdata` | `postgres` |
| `api_identity` | `api` only, at `/var/lib/pbmb/identity` |
| `worker_identity` | `worker` only, at `/var/lib/pbmb/identity` |

No volume is mounted by both `api` and `worker`. Containers share nothing
but Postgres and HTTP APIs, and code reaches each through a URI from the
environment (`DATABASE_URL`, `CERBOS_URL`, `PUBLIC_BASE_URL`), never a
path it knows.

## Hardening, on every service

- `security_opt: [no-new-privileges:true]` and `cap_drop: [ALL]`;
  `postgres` adds back only what its first start needs.
- `read_only: true`, with tmpfs where a process writes. `postgres` is the
  one writable root.
- A non-root user wherever the image allows it.
- Memory and CPU limits sized for a small VM, a health check, and
  `restart: unless-stopped`. No Docker socket, anywhere.
- The product's image is `powerbi-metrics-book`, built from
  `apps/api/Dockerfile`; every other image is pinned by digest.
- No secret is ever written in `compose.yml`. Bootstrap values come from
  the deployment's `.env`; everything else is in Postgres, encrypted for
  its reader.

A new container gets all of the above and only the networks it needs
(`docs/security/agents.md`, rule 4).

## Check

```bash
docker compose -f stack/compose.yml --env-file stack/.env.example config -q
pnpm --filter @powerbi-metrics-book/api exec vitest run src/stack
```

`apps/api/src/stack/compose_security_test.ts` fails when any of the above
breaks. It is never loosened to make a change pass.
