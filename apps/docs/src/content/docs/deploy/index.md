---
title: Deploy
description: One guide per target for running the stack, each ending in a check against the new address.
sidebar:
  order: 0
  label: Overview
---

This part has one guide for each place to run the stack, and each guide ends with `pbmb admin status` passing against the new address. It is for the person who chooses where the four containers run: the `api`, the `worker`, Cerbos and Postgres.

Every guide runs the release image `ghcr.io/enum-studio/powerbi-metrics-book:<version>` pinned by its digest, with `pbmb` from the `powerbi-metrics-book` package on PyPI at the same version. Each fetches its files from the commit the release's tag names.

Pick one and follow it from start to end:

| Guide | What runs where | Choose it when |
|---|---|---|
| [One VM with Docker Compose](/docs/deploy/vm/) | The compose file `pbmb init` writes, with Caddy in front for TLS, and nightly backups encrypted with age to two buckets off the VM. | You can run a Linux VM. This is the reference deployment, and the cheapest: we recommend a VM from Hetzner or Netcup, which cost much less than Azure, GCP or AWS. |
| [Dokploy or Coolify on a VM](/docs/deploy/dokploy/) | The same compose file as a Dokploy compose application, with Dokploy's Traefik giving the domain and certificate. Backups as on the VM. | You already run Dokploy or Coolify and want its dashboard. |
| [Railway](/docs/deploy/railway/) | One Railway project from one file, `.railway/railway.ts`: a service per container, the identities as sealed variables, and Railway's volume backups for Postgres. | You want no server to look after. |
| [Azure Container Apps](/docs/deploy/azure/) | One Bicep template: three container apps, PostgreSQL Flexible Server reachable only from the virtual network, Key Vault for every value, and a registry for the Cerbos image. | Your company already runs Power BI in Azure. |

There is no [Kubernetes](/docs/deploy/kubernetes/) chart yet; that page lists what the containers already meet.

Each guide says who acts at each step: you, at the terminal, or a person with a right you may not have, such as editing DNS or signing in to a dashboard. `pbmb login` in every guide needs a person to enter a code in a browser.

Run the [quickstart](/docs/start/quickstart/) first to see the stack work on one machine. Then come back here for the address people will open.
