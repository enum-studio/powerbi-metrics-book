# Deploy the public demo in Dokploy

A person with production rights creates this demo in its own Dokploy project.
Use the invented sample tenant only. Never use the production project, its
environment, its database or its identity volumes.

Put the demo on a Dokploy server that does not run production, if you have
one. Every application on one Dokploy server joins `dokploy-network`, and
any of them could name a false client address to another (step 3). The
demo tags its images with its own project name, so a shared Docker host
would not mix up images, but the network would still be shared. On a
shared server, the demo is a public container on that network beside
production's api, and on the same Docker host: the threat model's residual
risks say what that leaves open.

1. In Dokploy, create a project named `powerbi-metrics-book-demo`. Create a
   Compose service of type **Docker Compose**, not Stack, so `depends_on`
   waits for healthy services. In General, select
   `https://github.com/enum-studio/powerbi-metrics-book`, branch `main`, and
   Compose Path `./stack/compose.yml`.
2. In Advanced, leave **Isolated Deployments** off. Dokploy must attach its
   proxy network only to the api. Set Command to the following, replacing
   `<app-name>` with this demo application's App Name from General:

   ```text
   compose -p <app-name> -f ./stack/compose.yml -f ./deploy/dokploy/compose.dokploy.yml -f ./deploy/demo/compose.demo.yml up -d --build --remove-orphans --force-recreate
   ```

   All paths resolve from `stack/compose.yml`. The first layer builds the
   product image and the demo layer builds the mock from this checkout.
   `--build` makes each deploy rebuild both; without it, compose keeps the
   images from the first deploy and a push to `main` changes nothing.
   Dokploy adds a suffix to the App Name, such as `pbmb-demo-a1b2c3`, and
   reads the containers by it, so `-p` must be that name exactly.
3. On the VM, find Traefik's address on `dokploy-network`:

   ```bash
   docker network inspect dokploy-network --format '{{range .Containers}}{{if eq .Name "dokploy-traefik"}}{{.IPv4Address}}{{end}}{{end}}' | cut -d/ -f1
   ```

   Set `TRUSTED_PROXY` to the one address it prints, with no `/24`: the
   api refuses to start with `10.0.1.25/24`, a range written by an address
   inside it. Traefik connects through `dokploy-network`, so
   trusting the `edge` subnet would count everyone against the proxy's
   address, and trusting the network's whole range would let any
   application on the server name a visitor's address. Without
   `TRUSTED_PROXY` the api refuses to start in demo mode, since every
   visitor would then share the proxy's one limit. Check it from your own
   machine once the demo runs: `GET /api/v1/me` on the demo shows your
   public IPv4 address (`curl -4 https://ifconfig.me`) as
   `client_address`, also with `X-Forwarded-For: 192.0.2.1` sent. Check
   again after a Dokploy upgrade, a change to Traefik's settings, or a
   restart of Traefik, Docker or the server, any of which can give Traefik
   a new address; the Dokploy guide's step 4 says what a stale address
   does, and how the api's log shows one.
4. In Environment, enter the variables below. Dokploy writes them to the
   application's `.env`. A person generates and pastes the values there;
   never put them in git or send them to an agent. For each of the six
   random values, run `openssl rand -hex 32` separately on your own machine.

   | Variable | Value or how to make it |
   | --- | --- |
   | `PUBLIC_BASE_URL` | `https://demo.powerbimetricsbook.io` |
   | `POSTGRES_PASSWORD` | A fresh output of `openssl rand -hex 32` |
   | `MIGRATOR_PASSWORD` | A separate output of `openssl rand -hex 32` |
   | `API_RW_PASSWORD` | A separate output of `openssl rand -hex 32` |
   | `WORKER_RW_PASSWORD` | A separate output of `openssl rand -hex 32` |
   | `AUDIT_WRITER_PASSWORD` | A separate output of `openssl rand -hex 32` |
   | `AUTH_SECRET` | A separate output of `openssl rand -hex 32` |
   | `TRUSTED_PROXY` | The address printed in step 3 |
   | `LOG_LEVEL` | `info` |
   | `PBMB_EDGE_SUBNET` | An unused private `/24` on this VM, such as `172.30.81.0/24`; check existing networks first |

   Leave `PBMB_PORT` unset: the Dokploy layer removes published ports.
   Leave `API_AGE_IDENTITY`, `WORKER_AGE_IDENTITY` and `IDENTITY_DIR` unset:
   api and worker generate separate identities in their named volumes;
   seed reads the api's volume at `/var/lib/pbmb/identity`.
   `COMPOSE_PROJECT_NAME` comes from `-p <app-name>` in the command.
   Optionally set `GIT_SHA` to the deployed `main` commit for build metadata.

   The layer fixes `DEMO_MODE=1`, `NODE_ENV=production`,
   `USAGE_CAPTURE=false`, `ACCESS_METADATA_VISIBILITY=everyone` and all five
   mock URL overrides for api, worker and seed. Seed runs with
   `DEMO_MODE=1` too, and its setup walk writes through an in-process app
   it builds without the demo's read-only rule (`serveDemo: false`). The mock fixes `PORT=3001`, its internal
   `MOCK_ORIGIN`, `MOCK_CONTROL=1` and `SAMPLE_PUBLIC_BASE_URL` from
   `PUBLIC_BASE_URL`. These need no Environment entries or external keys.
5. In Domains, add host `demo.powerbimetricsbook.io`, path `/`, service
   `api`, container port `3000`, HTTPS on and certificate Let's Encrypt.
   Add no domain to any other service. Create a DNS `A` record named
   `demo` under `powerbimetricsbook.io`, pointing to the VM's public IPv4
   address. Wait for the record to resolve, then click **Deploy**.
6. In the demo application's containers, wait for api and worker to become
   healthy. Seed runs once after both are healthy. Check that its container
   has state **Exited (0)**. Open its logs and read the last line to confirm
   the sample setup and book finished. An exit other than 0 means setup
   failed; read its error and correct it before checking the demo.
7. Open `https://demo.powerbimetricsbook.io/health` and confirm HTTP 200.
   Then open `https://demo.powerbimetricsbook.io/` in a fresh browser
   session. The home page must open with sample data and no sign-in.

To start over, stop this demo application and remove its containers. Remove
only its named volumes: `<app-name>_pgdata`, `<app-name>_api_identity` and
`<app-name>_worker_identity`. In Dokploy, deploy the same application again.
The fresh database and identities cause seed to run setup and populate the
sample book again. A normal redeploy keeps these volumes and repeats the
seed safely.
