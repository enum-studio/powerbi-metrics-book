---
title: Dokploy or Coolify on a VM
description: The compose file pbmb init writes, run as a Dokploy compose application, with its domain and TLS from Dokploy. Coolify's differences at the end.
sidebar:
  order: 2
---

Dokploy runs the compose file `pbmb init` writes as one compose application, and its Traefik gives the `api` its domain and certificate. This guide ends with `pbmb admin status` passing against the new address. Read the [VM guide](/docs/deploy/vm/) first: the VM, the backups and the upgrades work the same way here, and this page says only what differs.

The release's image is `ghcr.io/enum-studio/powerbi-metrics-book:<version>` and its CLI the `powerbi-metrics-book` package on PyPI, at the same version. `pbmb init` pins the image by digest.

:::note
This guide has not been followed on a real account yet, so report where it differs.
:::

## 1. The VM and Dokploy

**A person** creates an Ubuntu 24.04 VM as in the VM guide's step 1 (4 GB of memory: Dokploy needs 2 GB of its own), opens 22, 80 and 443 in the cloud's firewall, and opens 3000 to their own address only. Then, as root on the VM, Dokploy's installer from [its installation page](https://docs.dokploy.com/docs/core/installation):

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

**A person** opens `http://<the VM's address>:3000` and creates Dokploy's admin account. The dashboard can deploy anything on this VM, so the person also:

- Turns on two-factor authentication or a passkey for every Dokploy account, under the profile ([account security](https://docs.dokploy.com/docs/core/account-security)).
- Keeps port 3000 open in the cloud's firewall to their own fixed addresses only, and never to everyone. Docker publishes Dokploy's port past `ufw`, so the cloud's firewall is the one that holds ([server security](https://docs.dokploy.com/docs/core/remote-servers/security)).

## 2. The deployment, in git

On your own machine, with `git` installed, which `git ls-remote` below needs too:

```bash
PBMB_VERSION=0.1.0
uv tool install "powerbi-metrics-book==$PBMB_VERSION"
pbmb init ./pbmb-deployment --public-base-url https://metrics.example.com
cd ./pbmb-deployment
COMMIT="$(git ls-remote https://github.com/enum-studio/powerbi-metrics-book "refs/tags/v$PBMB_VERSION" "refs/tags/v$PBMB_VERSION^{}" | tail -n 1 | cut -f 1)"
echo "$COMMIT"
curl -fsSLO "https://raw.githubusercontent.com/enum-studio/powerbi-metrics-book/$COMMIT/deploy/dokploy/compose.dokploy.yml"
pbmb check .
git init && git add . && git commit -m "Add the Power BI Metrics Book deployment"
```

The file comes from the commit the tag `v0.1.0` names, which `git ls-remote` printed; compare it with the one on the release's GitHub page. Push the repository to a private repository that Dokploy can read. `.env` stays out of git: `pbmb init` wrote a `.gitignore` for it.

`compose.dokploy.yml` takes away the `api`'s published port. The generated file publishes it on `127.0.0.1:3000`, where Dokploy's own dashboard listens, and Traefik needs no published port.

## 3. The compose application

Every click in this step is **a person's**, in Dokploy's dashboard. In a project, **Create Service**, then **Compose**, of type **Docker Compose**. Not Stack: it runs on Docker Swarm, which ignores `depends_on`, and the `api` must wait for a healthy `postgres`.

- **General**: the Git provider, your repository and branch, and Compose Path `./compose.yml`.
- **Environment**: paste the whole of `.env` here. Dokploy writes it as `.env` beside the compose file, where compose reads it ([Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)). Agents do not read `.env`, so this is a person's step.
- **Advanced**, Command: replace the default with the line below, where `<app-name>` is the App Name Dokploy shows in General. It adds the overlay, and `--force-recreate` mounts the fresh clone's files on every deploy: Dokploy clones the repository again each time, and a container left running would keep the old, deleted files ([Volumes & Mounts](https://docs.dokploy.com/docs/core/troubleshooting/volumes-mounts)).

```text
compose -p <app-name> -f ./compose.yml -f ./compose.dokploy.yml up -d --remove-orphans --force-recreate
```

- **Advanced**: leave Isolated Deployments off. It adds a network to every service, which would put `postgres` and `cerbos` on a network that Traefik and the internet share. With it off, Dokploy adds `dokploy-network` to the one service that has a domain, the `api` ([Domains](https://docs.dokploy.com/docs/core/docker-compose/domains)). That network also carries Dokploy's own control plane, its Postgres and its Redis: the `api` can reach them, and they the `api`. Two-factor sign-in and the fixed addresses of step 1 are what keep Dokploy itself closed.
- **Domains**: Add Domain with host `metrics.example.com`, path `/`, service `api`, container port `3000`, HTTPS on, certificate Let's Encrypt.

**A person** adds the DNS `A` record for `metrics.example.com` to the VM's address, as in the VM guide's step 6. Then **Deploy**.

## 4. TRUSTED_PROXY

Traefik reaches the `api` over `dokploy-network`, not over `edge`. Every other application Dokploy runs on this server joins that network too, so trust Traefik's own address on it, not the network's whole range. A neighbour that connects to the `api` directly is then counted by its own address, and cannot name a client in `X-Forwarded-For`. On the VM:

```bash
docker network inspect dokploy-network --format '{{range .Containers}}{{if eq .Name "dokploy-traefik"}}{{.IPv4Address}}{{end}}{{end}}' | cut -d/ -f1
```

**A person** sets `TRUSTED_PROXY` to the one address it prints, such as `10.0.1.25`, in the Environment tab, and deploys again. Paste it as printed, with no `/24`. The `api` refuses to start with `10.0.1.25/24`, which names the network's whole range by Traefik's address in it and would trust every application on the network again. It does take the range written as `10.0.1.0/24`, which trusts them all too, so set no range here. Never set the address of `dokploy-network-endpoint`, which carries any application's traffic. Left empty, every sign-in counts against Traefik's one address and all share one limit.

After step 5, from your own machine, check it: send a made-up address and see what the `api` reports.

```bash
pbmb whoami
jq -r '"Authorization: Bearer " + .access_token' "${XDG_CONFIG_HOME:-$HOME/.config}/pbmb/credentials.json" |
  curl -sS -H @- -H 'X-Forwarded-For: 192.0.2.1' https://metrics.example.com/api/v1/me | jq -r .client_address
curl -4 -sS https://ifconfig.me
```

The first address should match the second, your own public IPv4 address. A private address such as `10.0.1.25` means Traefik connects from an address you did not set.

Traefik's address can change whenever Docker gives it a new one: a Dokploy upgrade, a change to Traefik's settings in Dokploy, a restart of Traefik or of Docker, a reboot. The `api` then counts every visitor as Traefik: sign-ins share one limit, and a service account key limited by `source_cidrs` is refused, unless one of its ranges holds `dokploy-network`'s own. That is safe at first, but Docker can later give the old address to another container on the network, a redeploy of any application, and that container may then name any client. Run the check after each of those events, and set the new address at once if it changed.

The `api` also warns in its log when this happens. Once a minute at most, while requests carry `X-Forwarded-For` from an address outside `TRUSTED_PROXY`, it writes a line for each such address with how many requests came from it since the last round. After Traefik gets a new address every request does this, so one line names Traefik's new address. On the VM:

```bash
docker logs <app-name>-api-1 2>&1 | grep 'outside TRUSTED_PROXY' | tail -n 20
```

A line such as `"peer":"10.0.1.31","trusted_proxy":"10.0.1.25"` says a connection from `10.0.1.31` sent the header. Any container on `dokploy-network` can send it and get such a line, so never set `TRUSTED_PROXY` from the log: run the lookup above. If it prints an address other than `TRUSTED_PROXY`, Traefik has moved: set the address the lookup prints. If it prints `TRUSTED_PROXY`, other containers sent the header themselves, and the `api` counted each by its own address. Nothing alerts you to these lines; read them after the events above, or point your log monitoring at them.

Two limits remain while other applications share the server. A neighbour container that keeps Docker's default `NET_RAW` capability can pretend to be Traefik's address on the network. And the hop from Traefik to the `api` is plain HTTP, so such a neighbour could read the tokens and results on it. The stack's own containers drop every capability; another application's may not. Keep this VM to this stack where you can.

## 5. The setup link and the check

On the VM, with `<app-name>` as above:

```bash
docker exec <app-name>-api-1 server setup-link
```

The link is printed by the command, not in the log. It works once, for 24 hours. Open it and follow the [Set up](/docs/set-up/) part. Then, from your own machine:

```bash
pbmb login --url https://metrics.example.com
pbmb admin status
```

`pbmb login` prints a code; **a person** opens the address it names in a browser, enters the code and signs in. `pbmb admin status` answers, and any check it lists as failing says what to change: a secret saved without its expiry date is one.

## Volumes and backups

The data lives in named volumes, `<app-name>_pgdata`, `<app-name>_api_identity` and `<app-name>_worker_identity`. They stay through every redeploy. Never delete the service with its volumes.

Back up with the VM guide's step 9, run on this VM, with `PBMB_PROJECT=<app-name>` in `/etc/pbmb-backup.env`. Set `COMMIT` and `base` first as in the VM guide's step 5, so the backup files come from the same commit as `compose.dokploy.yml`. The script finds the containers by their compose labels, so it works for a project Dokploy started. Dokploy's own Volume Backups copy a volume as files; for `pgdata` that is only safe with the container stopped, which the nightly `pg_dump` avoids.

## Upgrading

Run `pbmb init` of the new version into a new folder made with `mktemp -d`, as in the VM guide's Upgrading section, copy its `compose.yml`, `cerbos/` and `postgres/` into your repository, fetch the new `compose.dokploy.yml`, commit, push and deploy.

## Coolify

Coolify runs a compose file from git the same way, with these differences ([Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)):

- Coolify makes one network for the compose resource and puts every service on it, so that services reach each other by name. That joins `postgres` and `cerbos` to a network that reaches the internet, which `compose.yml` keeps them off. To keep the separation, choose **Raw (deploy file as-is)** under Advanced, and add the proxy's labels and network to the `api` yourself.
- The domain goes on the `api` with its port: `https://metrics.example.com:3000`.
- Files from the repository survive a redeploy only with **Preserve repository during deployment** on, under General.
- Environment variables go in the resource's Environment Variables page, as in Dokploy.

The Coolify steps come from its documentation and have not been run end to end yet.
