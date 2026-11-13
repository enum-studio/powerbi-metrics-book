---
title: Railway
description: One Railway project from one Infrastructure as Code file, with a service per container, a volume each for the identities, and the public domain on the api only.
sidebar:
  order: 3
---

One file, `.railway/railway.ts`, describes the whole Railway project: the `api` and the `worker` from the release image, Cerbos and Postgres with pgvector built from your deployment repository, each container's identity as a sealed variable, and the public domain on the `api` only. This guide ends with `pbmb admin status` passing against the new address.

The file uses Railway's [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code). Railway's older per-service `railway.json` is deprecated: new services cannot use it, and existing files stop being read on 2026-12-01.

The release's image is `ghcr.io/enum-studio/powerbi-metrics-book:<version>` and its CLI the `powerbi-metrics-book` package on PyPI, at the same version. The file pins the image by digest.

:::note
This guide has not been followed on a real account yet, so report where it differs.
:::

## What you need

- **A person** with a Railway account, who connects Railway's GitHub app to the deployment repository.
- The [Railway CLI](https://docs.railway.com/cli), 5.42.1 or newer, signed in with `railway login`; Node 24 with `npm`; `pbmb` at the release's version; Docker, for `pbmb check`; `age-keygen` from [age](https://age-encryption.org); `jq`; `git`, for `git ls-remote` in step 1.
- **A person** who can add DNS records for the address people will open.

## 1. The deployment repository

```bash
PBMB_VERSION=0.1.0
uv tool install "powerbi-metrics-book==$PBMB_VERSION"
pbmb init ./pbmb-deployment --public-base-url https://metrics.example.com
cd ./pbmb-deployment
COMMIT="$(git ls-remote https://github.com/enum-studio/powerbi-metrics-book "refs/tags/v$PBMB_VERSION" "refs/tags/v$PBMB_VERSION^{}" | tail -n 1 | cut -f 1)"
echo "$COMMIT"
base="https://raw.githubusercontent.com/enum-studio/powerbi-metrics-book/$COMMIT/deploy"
mkdir -p .railway railway
curl -fsSL "$base/railway/railway.ts" -o .railway/railway.ts
curl -fsSL "$base/railway/postgres.Dockerfile" -o railway/postgres.Dockerfile
curl -fsSLO "$base/cerbos.Dockerfile"
curl -fsSLO "$base/railway/package.json" && curl -fsSLO "$base/railway/package-lock.json"
npm ci
printf 'node_modules/\n*.key\n' >> .gitignore
```

`git ls-remote` asks GitHub which commit the tag names, and the files come from that commit, so they cannot change under you if the tag moves. To check it, compare the printed commit with the one on the release's GitHub page. `npm ci` installs the `railway` package at the version the lockfile pins, which `railway config` needs to read the file. The `*.key` line keeps any age key out of git.

Edit the four values at the top of `.railway/railway.ts`:

| Value | What |
|---|---|
| `IMAGE` | the image line in `compose.yml`, from `grep 'image: &image' compose.yml` |
| `PUBLIC_HOST` | `metrics.example.com`, the host of `PUBLIC_BASE_URL` |
| `REPOSITORY`, `BRANCH` | this repository on GitHub, such as `example-org/pbmb-deployment`, and its branch |

Then check, commit and push. `.env` stays out of git:

```bash
pbmb check .
git init && git add . && git commit -m "Add the Power BI Metrics Book deployment"
```

Push it to a private GitHub repository that Railway's GitHub app can read.

## 2. The identities

Each container decrypts its secrets with an age identity. On Railway each is a sealed variable: Railway hands it to the container and never shows it again, in the dashboard or through the API ([sealed variables](https://docs.railway.com/variables#sealed-variables)). Make both in a new folder outside the repository, readable by you only:

```bash
keys="$(mktemp -d)"
(umask 077 && age-keygen -o "$keys/api.key" && age-keygen -o "$keys/worker.key")
echo "$keys"
```

Never write these files into the deployment repository.

## 3. The project and its shared variables

**A person** creates an empty project in Railway's dashboard. Link this folder to it:

```bash
railway link
```

**A person** opens Project Settings, Shared Variables, and adds eight values. Six come from `.env`: `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `API_RW_PASSWORD`, `WORKER_RW_PASSWORD`, `AUDIT_WRITER_PASSWORD` and `AUTH_SECRET`. Two come from the folder of step 2: `API_AGE_IDENTITY` and `WORKER_AGE_IDENTITY`, each the `AGE-SECRET-KEY-1...` line of `api.key` or `worker.key`. Then **the person** seals each of the eight, in its menu. Agents do not read `.env` or the keys, so this is a person's step.

The person then moves the two key files to the company's password manager and deletes the folder: they are the only copy outside Railway, and every secret in the database is encrypted to them.

The file never holds a value. Each service gets only the shared variables it names: Postgres the five passwords, the `api` its own password, the migrator's, the audit writer's, `AUTH_SECRET` and its identity, and the `worker` its own password, the audit writer's and its identity. The database URLs are built from them at deploy with Railway's reference syntax, such as `${{shared.API_RW_PASSWORD}}` and `${{postgres.RAILWAY_PRIVATE_DOMAIN}}` ([variables](https://docs.railway.com/variables)).

## 4. Plan and apply

```bash
railway config plan
railway config apply
```

The plan lists five services and one volume to create. Apply asks you to confirm it. Postgres and Cerbos build from the repository: Postgres is pgvector's image, pinned by digest, with `postgres/init/` inside, which makes the roles, the database and the extensions on its first start; Cerbos holds `cerbos/config.yaml`, the release's default policies and your `access/policies/`, and runs as user `10001`. The fifth, `edge-check`, serves step 5 only.

The services reach each other over Railway's private network, as `postgres.railway.internal` and `cerbos.railway.internal`. Railway gives every service a way out to the internet, so Postgres and Cerbos are not kept off it as on a VM.

## 5. The edge check

Sign-in rate limits count by the client's address. Railway's edge sets `X-Real-IP` to it ([public networking specs](https://docs.railway.com/networking/public-networking/specs-and-limits)), but its pages do not say it replaces an `X-Real-IP` the client sends. If it does not, anyone could pick the address their sign-ins count against. So the `api` does not read the header yet: first test the edge with `edge-check`, a pinned Caddy that answers with the `X-Real-IP` it receives.

```bash
railway domain --service edge-check --port 8080
curl -sS -H 'X-Real-IP: 192.0.2.1' https://<the domain it printed>/
echo
curl -sS https://ifconfig.me
```

- The two addresses match, your own public address: the edge replaced your header. In `.railway/railway.ts` set `EDGE_CHECK = false` and `CLIENT_ADDRESS_FROM_EDGE = true`, then commit, push, plan and apply. The plan deletes `edge-check` and sets `CLIENT_ADDRESS_HEADER=x-real-ip` on the `api`.
- It prints `192.0.2.1`: the edge passed your header on. Set `EDGE_CHECK = false` only, and apply. Every sign-in then counts against the edge's address and all share one limit: Railway names no address range its edge connects from, so there is nothing for `TRUSTED_PROXY` to trust.

Run the check again, with `EDGE_CHECK = true`, after any change to Railway networking: a new domain, a proxy in front, or a change in Railway's [changelog](https://railway.com/changelog) to its edge.

Never set `TRUSTED_PROXY` here: the `api` refuses to start with both. Under `CLIENT_ADDRESS_HEADER` the `api` also refuses to hold a service account to source CIDRs.

## 6. The address

On the `api` service's Settings, under Networking, Railway shows two DNS records for `metrics.example.com`: a `CNAME` and a `TXT` record. **A person** adds both exactly as shown ([working with domains](https://docs.railway.com/networking/domains/working-with-domains)). Railway issues the certificate, usually within an hour.

## 7. The setup link and the check

```bash
railway ssh --service api -- server setup-link
```

The link is printed by the command, not in the log. It works once, for 24 hours. Open it and follow the [Set up](/docs/set-up/) part. Then:

```bash
pbmb login --url https://metrics.example.com
pbmb admin status
```

`pbmb login` prints a code; **a person** opens the address it names in a browser, enters the code and signs in. `pbmb admin status` answers, and any check it lists as failing says what to change: a secret saved without its expiry date is one.

Once signed in, the `api` itself reports the address it counts you by:

```bash
jq -r '"Authorization: Bearer " + .access_token' "${XDG_CONFIG_HOME:-$HOME/.config}/pbmb/credentials.json" |
  curl -sS -H @- -H 'X-Real-IP: 192.0.2.1' https://metrics.example.com/api/v1/me | jq -r .client_address
```

The token goes to `curl` on its standard input, never on a command line. With `CLIENT_ADDRESS_FROM_EDGE = true` it prints your own public address, as step 5 did.

## What Railway does not offer

A service on Railway runs with the platform's own settings: Railway has no setting for a read-only root file system or for dropping Linux capabilities, both of which `compose.yml` sets on a VM. Postgres runs as the pgvector image starts it, as root until it hands over to its own `postgres` user.

### Identity volumes instead

With `IDENTITY_VOLUMES = true` in the file, each identity lives in a volume, and `server rotate-identity` works. The cost: Railway mounts a volume as `root`, and its [volumes page](https://docs.railway.com/volumes) gives one answer for an image that runs as another user, `RAILWAY_RUN_UID=0`, which the file then sets. The `api` and the `worker` then run as root, not as user `10001`. Leave out `API_AGE_IDENTITY` and `WORKER_AGE_IDENTITY` in step 3.

## Backups

**A person** turns on daily and weekly backups on the `pgdata` volume, in the Postgres service's Backups tab ([backups](https://docs.railway.com/volumes/backups)). Railway keeps daily backups 6 days and weekly ones 27, inside the same project: someone who can delete the project can delete them too. These backups keep everything in the database, query results included, which are at most 72 hours old when taken.

The identities are in the password manager from step 3, apart from the database. Keep them there, and add each new one after a rotation.

## Upgrading

Run `pbmb init` of the new version into a new folder made with `mktemp -d`, as in the VM guide's Upgrading section. Copy its image line into `IMAGE` and its `postgres/` and `cerbos/` into this repository, fetch the new files from step 1, commit, push, then `railway config plan` and `railway config apply`.

**Upgrading from any release before database migration `0003`** (invites and deactivation): the old and the new `api` must not serve at once. Railway starts the new deployment and moves traffic once its health check passes, so for a short while both run. The old one still gives an invite's role when it sends the invite, and can still accept an invite with a password. The old one also ends invites in a way the new one reads only at its start, and migration `0004` removes that record, so take a release with `0003` and without `0004` first and let it start. A later release refuses to start until that one has, and says so. For this upgrade, remove the `api` service's active deployment before you apply. Sign-in and the connector are down until the new deployment is healthy, usually under a minute.

## Rotating an identity

With sealed identities, `server rotate-identity` refuses: make a new key as in step 2, put it in the shared variable, and enter that container's secrets again in the admin section. With identity volumes:

```bash
railway ssh --service api -- server rotate-identity
railway restart --service api
keys="$(mktemp -d)"
railway volume files --volume api-identity download /api.key "$keys/api.key"
```

The same works for the `worker`. The last two commands save the new identity in a new folder outside the repository; move it to the password manager.
