---
title: Kubernetes
description: Not packaged yet. What the containers already meet, and how to ask for a Helm chart.
sidebar:
  order: 5
---

There is no Helm chart yet. The stack is four containers, and the [VM guide](/docs/deploy/vm/) runs it on one machine with room to spare, so a chart waits until a company needs one.

The containers already meet what Kubernetes asks of them:

- **The `api` is stateless.** Its state is in Postgres and its identity file, so more replicas need nothing else.
- **Migrations run once.** The `api` applies them at start under a Postgres advisory lock, so replicas starting together apply each migration once.
- **Health checks.** The `api` answers `GET /health` on port 3000. The `worker` touches `/tmp/worker-heartbeat` at least every 30 seconds, so an exec probe can check the file's age.
- **Configuration comes from the environment and the database.** The bootstrap values are environment variables; every other setting is in Postgres.
- **Non-root, read-only.** The image runs as user `10001` and writes only to `/tmp` and its identity directory, `/var/lib/pbmb/identity`.

The image is the release's, `ghcr.io/enum-studio/powerbi-metrics-book:<version>`, and the CLI is the `powerbi-metrics-book` package on PyPI at the same version. Run the image by digest, as `pbmb init` writes it in `compose.yml`, never by tag alone.

Set `TRUSTED_PROXY` on the `api` to the addresses of your ingress controller's own pods, never the whole pod network's range: any pod in that range could name a client. Only a connection from there may name the client in `X-Forwarded-For`, and sign-in rate limits count by that client. Left unset, every sign-in counts against the ingress's address and all share one limit.

Each of the `api` and the `worker` needs its own volume for its identity, mounted by that one workload only, or its identity from a Kubernetes secret as `API_AGE_IDENTITY` or `WORKER_AGE_IDENTITY`. Run one `worker`: each worker runs the schedule.

If you need a chart, [open an issue](https://github.com/enum-studio/powerbi-metrics-book/issues) and say which cluster and which ingress you run.
