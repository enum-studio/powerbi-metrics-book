---
title: One VM with Docker Compose
description: The reference deployment. One Linux VM runs the compose file pbmb init writes, with Caddy in front for TLS, nightly backups off the machine and a firewall that leaves three ports open.
sidebar:
  order: 1
---

This guide runs the whole stack on one Linux VM: the compose file `pbmb init` writes, Caddy in front of the `api` for TLS, and a nightly backup to storage off the VM. It ends with `pbmb admin status` passing against the new address. Each step says who acts: **you** (the person or agent at the terminal) or **a person** with a right you may not have, such as editing DNS.

Every release names its image and its CLI the same way: the image `ghcr.io/enum-studio/powerbi-metrics-book:<version>` and the `powerbi-metrics-book` package on PyPI, both at the same version. `pbmb init` pins the image by its digest, so the stack never runs an image by tag alone. The commands below use the version in a variable:

```bash
PBMB_VERSION=0.1.0
```

## 1. The VM

**A person** creates the VM in their cloud account. We recommend [Hetzner](https://www.hetzner.com/cloud) or [Netcup](https://www.netcup.com/en/server/vps): a VM this size costs much less there than at Azure, GCP or AWS. Any provider that meets this list works:

- Ubuntu 24.04 LTS or 26.04 LTS, 64-bit (`x86_64` or `arm64`).
- 2 vCPUs, 4 GB of memory and 40 GB of disk at least, such as AWS `t3.medium`. The containers' memory limits add up to 2.7 GB.
- A public IPv4 address, and SSH access for you.
- The cloud's own firewall (security group) open on 22, 80 and 443 only.

## 2. Docker, from Docker's repository

Ubuntu's own `docker.io` package is older than the stack needs (Docker Engine 28 or newer). These commands are Docker's own, from [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/):

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in, so your user is in the `docker` group. That group can do anything as root on this machine, so add only the people who run the stack. Check:

```bash
docker version --format '{{.Server.Version}}'
```

It prints 28 or higher.

## 3. The firewall

Leave 22 (SSH), 80 and 443 open, and nothing else:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

`ufw enable` may warn that it can disrupt SSH connections and ask to proceed. Answer `y`: port 22 is open above.

Docker's published ports skip `ufw` ([Docker's firewall notes](https://docs.docker.com/engine/network/packet-filtering-firewalls/)). Here only Caddy publishes ports, 80 and 443, so the two agree. Keep it that way: never publish another port.

## 4. pbmb and the deployment

`pbmb` needs Python 3.13, and Ubuntu's own Python is not that (3.12 on 24.04), so `pipx install powerbi-metrics-book` stops with "requires a different Python". Install `uv` with `pipx`; `uv` fetches Python 3.13 itself and installs `pbmb` with it:

```bash
sudo apt install -y pipx
pipx install uv
pipx ensurepath
export PATH="$HOME/.local/bin:$PATH"
uv tool install --python 3.13 "powerbi-metrics-book==$PBMB_VERSION"
```

`pipx ensurepath` puts `~/.local/bin` on the path of new shells; the `export` does the same for this one, so you keep `PBMB_VERSION`, which steps 5 and 9 use. Then write the deployment into `/srv/pbmb`, replacing the address with the one people will open:

```bash
sudo install -d -o "$USER" -g "$USER" -m 0700 /srv/pbmb
pbmb init /srv/pbmb --public-base-url https://metrics.example.com
cd /srv/pbmb
```

`.env` now holds new random passwords. **A person** keeps a copy somewhere safe, such as the company's password manager: without it the database cannot be reached again. Never commit it, and never print it.

## 5. Caddy in front

Fetch the overlay and the Caddyfile from the commit your version's tag names:

```bash
cd /srv/pbmb
COMMIT="$(git ls-remote https://github.com/enum-studio/powerbi-metrics-book "refs/tags/v$PBMB_VERSION" "refs/tags/v$PBMB_VERSION^{}" | tail -n 1 | cut -f 1)"
echo "$COMMIT"
base="https://raw.githubusercontent.com/enum-studio/powerbi-metrics-book/$COMMIT/deploy"
curl -fsSLO "$base/vm/compose.caddy.yml"
curl -fsSLO "$base/vm/Caddyfile"
```

`git ls-remote` asks GitHub which commit the tag names, and the files come from that commit, so they cannot change under you if the tag moves. It prints 40 hexadecimal characters. If it prints nothing, the tag `v$PBMB_VERSION` does not exist and the `curl` commands would fetch nothing: stop and check the version. To check the commit, compare it with the one on the release's GitHub page. Step 9 uses `$base` too: keep this shell open, or run the `PBMB_VERSION`, `COMMIT` and `base` lines again in a new one.

`compose.caddy.yml` adds `caddy` on the `edge` network, publishing 80 and 443, and takes away the `api`'s own port. Caddy runs as user `10001`, not root, with one capability: listening on ports below 1024. The Caddyfile serves the host in `PUBLIC_BASE_URL` with a Let's Encrypt certificate and HSTS.

Then set two values in `.env`. Each command changes one line and prints nothing:

```bash
sed -i 's|^TRUSTED_PROXY=$|TRUSTED_PROXY=172.30.80.10|' .env
echo 'COMPOSE_FILE=compose.yml:compose.caddy.yml' >> .env
```

`172.30.80.10` is Caddy's fixed address on the `edge` network. Caddy connects to the `api` from there and names the client in `X-Forwarded-For`, so sign-in rate limits count each client. Only that one address may name a client, and Docker gives other containers on `edge` addresses from `172.30.80.128/25` only, so none can take it. Left empty, every sign-in would count against Caddy's address and share one limit. If you set `PBMB_EDGE_SUBNET` to another range, also set `PBMB_CADDY_ADDRESS` in `.env` to an address in its lower half, `PBMB_EDGE_IP_RANGE` to its upper half, and use `PBMB_CADDY_ADDRESS` here. `COMPOSE_FILE` makes every `docker compose` command in this folder read both files.

## 6. DNS

**A person** who manages the company's DNS adds an `A` record for the host in `PUBLIC_BASE_URL` (`metrics.example.com`) with the VM's public IPv4 address. Check from the VM, which has no `dig` until you install it:

```bash
getent ahostsv4 metrics.example.com | head -n 1
```

It prints the VM's address first. Caddy can get a certificate only once it does.

## 7. Start

```bash
pbmb check /srv/pbmb
docker compose up -d --wait
```

`pbmb check` reads `.env` and runs your policy tests. The first start pulls the images, creates the database and applies its migrations; `--wait` returns when every container is healthy.

## 8. The setup link

```bash
docker compose exec api server setup-link
```

The link is printed by the command, not in the log. It works once, for 24 hours; run the command again for a new one. Open it, then follow the [Set up](/docs/set-up/) part. Its Entra steps need **a person** who can register apps in the company's Entra tenant and grant admin consent.

## 9. Backups

Every night a script dumps the database with `pg_dump` and copies the two identity volumes. It encrypts each file with [age](https://age-encryption.org) to a key that is not on the VM, then sends it off the VM with `rclone`. The dump runs as `migrator`, the role that owns every table: `setting_check` and the secrets tables have row-level security, and `pg_dump` refuses a table whose rows a policy would hide from the role it runs as.

A dump holds every row in plain text except the secrets, which the database keeps encrypted to the identities, and the query results, which it leaves out: `pg_dump` runs with `--exclude-table-data` for `query_result` and `query_result_page`, so those tables restore empty. The query log keeps the DAX, so after a restore an agent runs a query again, and an old result id answers as not found. The script encrypts it in a pipe, before it touches the disk. The dumps and the identities go to different places with different keys on purpose: the two together open every secret.

**A person** prepares the two places, on a machine other than the VM:

1. Two age key pairs, one for dumps and one for identities, made with age (`brew install age` on a Mac, `sudo apt install age` on Ubuntu): `age-keygen -o dumps-key.txt` and `age-keygen -o identities-key.txt`. Each prints its public key, `age1...`. The two files stay off the VM, in the company's password manager: without them no backup can be read.
2. Two buckets in different accounts, such as two S3 buckets each in its own AWS account. Each gets versioning, Object Lock with a default retention of 35 days, and a lifecycle rule that deletes objects after 35 days. Nothing on the VM deletes a backup, so a stolen VM cannot erase them.
3. For each bucket, a credential that may write and do nothing else: on S3, a policy allowing only `s3:PutObject` on that bucket. The script never lists or reads the bucket.

Then on the VM, one rclone configuration file per bucket. For an S3 bucket, answer `true` to `no_check_bucket` and `no_head` under the advanced options, so rclone never asks to read:

```bash
sudo apt install -y rclone age
sudo install -d -m 0700 /etc/pbmb-backup
sudo rclone config --config /etc/pbmb-backup/dumps.conf
sudo rclone config --config /etc/pbmb-backup/identities.conf
echo 'age1...the dumps public key' | sudo tee /etc/pbmb-backup/dumps.recipient
echo 'age1...the identities public key' | sudo tee /etc/pbmb-backup/identities.recipient
```

In `dumps.conf` name the remote `dumps`, and in `identities.conf` name it `identities`. Then install the script, its settings and the systemd units, from the commit of step 5:

```bash
sudo curl -fsSL "$base/vm/backup/pbmb-backup.sh" -o /usr/local/bin/pbmb-backup.sh
sudo chmod 0755 /usr/local/bin/pbmb-backup.sh
sudo install -m 0600 /dev/null /etc/pbmb-backup.env
sudo curl -fsSL "$base/vm/backup/backup.env.example" -o /etc/pbmb-backup.env
for unit in pbmb-backup.service pbmb-backup-failed.service pbmb-backup.timer; do
  sudo curl -fsSL "$base/vm/backup/$unit" -o "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now pbmb-backup.timer
```

`/etc/pbmb-backup.env` already names the project `pbmb` (from `/srv/pbmb`). The file is readable by root only, because the alert address below works as a password: anyone who has it can post to it. Set `PBMB_BACKUP_ALERT_URL` in it to an address that takes a POST, such as a [healthchecks.io](https://healthchecks.io) check's `/fail` address or an [ntfy](https://ntfy.sh) topic: when a backup fails, `pbmb-backup-failed.service` posts there and logs the failure at error priority. Run one backup now and read its result:

```bash
sudo systemctl start pbmb-backup.service
journalctl -u pbmb-backup.service -n 5 --no-pager
```

The last line reads `Backed up pbmb at ...`, and `systemctl list-timers pbmb-backup.timer` shows the next run, at 01:15 or up to 15 minutes later. **A person** checks once that the three files arrived in the two buckets. Until the next success, `systemctl --failed` lists a failed backup too.

## 10. Check

From your own machine, with `pbmb` installed at the same version. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) there first (step 4 installed it on the VM only), then run `uv tool install --python 3.13 "powerbi-metrics-book==$PBMB_VERSION"`:

```bash
curl -sI https://metrics.example.com/health | grep -i strict-transport-security
pbmb login --url https://metrics.example.com
pbmb admin status
```

The first prints the HSTS header. `pbmb login` prints a code; **a person** opens the address it names in a browser, enters the code and signs in. `pbmb admin status` answers with the deployment's status, and any check it lists as failing says what to change: a secret saved without its expiry date is one. It needs the setup done and you signed in as an admin.

## Upgrading

`pbmb` and the image move together: the new `pbmb` knows its own image's digest, and writes it.

```bash
PBMB_VERSION=0.2.0
uv tool install --force --python 3.13 "powerbi-metrics-book==$PBMB_VERSION"
new="$(mktemp -d)"
pbmb init "$new/pbmb"
diff -r --exclude=.env --exclude=access "$new/pbmb" /srv/pbmb
```

Read the release notes and the difference, then copy the new `compose.yml`, `cerbos/` and `postgres/` over the old ones, fetch the new `compose.caddy.yml` and `Caddyfile` as in step 5, and start:

```bash
cp "$new/pbmb/compose.yml" /srv/pbmb/
cp -R "$new/pbmb/cerbos" "$new/pbmb/postgres" /srv/pbmb/
rm -r "$new"
cd /srv/pbmb && docker compose up -d --wait
```

The `api` applies the new migrations at start. Run a backup first if the release notes name a migration.

When a release moves Postgres or the glibc under it, the same start rebuilds the indexes that depend on them, which takes seconds. If a sync is writing, the start waits for it. After a minute with no index rebuilt it stops, naming what held it, and Docker starts it again. If the `api` stops with `Two rows share a key in` and an index's name, that index went stale and let in a duplicate. Clear it as the `migrator`:

1. Run `reindex index <the index>`. Its error shows the key, and Postgres's log keeps a copy of that error.
2. In the same connection, run `set enable_indexscan = off; set enable_bitmapscan = off;` and look the rows up. The stale index can hide one of them.
3. Decide which row goes, delete it, and start again.

Deleting a row can take others with it, so read what refers to it first. A `user` takes that person's sessions, sign-ins, OAuth tokens and Power BI connection. A `powerbi_table` takes its columns and measures, a `powerbi_measure` its `metric_variant`s, and a `powerbi_column` its `term_column`s. For two rows in `pii_rule`, keep the one that says PII unless you have reviewed the name.

## Restoring

On a new VM, follow steps 1 to 7 up to `pbmb check`, with the deployment again in `/srv/pbmb`. Put the `.env` you kept in place of the one `pbmb init` wrote, and skip the two `.env` commands in step 5: the kept file has both lines. Every command below names the project with `-p pbmb`, the name the backups were taken under, so the volumes are the ones the stack uses.

```bash
cd /srv/pbmb
docker compose -p pbmb up -d --wait postgres
docker compose -p pbmb exec -T postgres psql --username=postgres --dbname=powerbi_metrics_book --tuples-only --no-align \
  --command="select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')"
```

It prints `0`: Postgres started empty, with its roles and the database made from `.env`. Any other number means this database already holds tables: stop, and restore into a new deployment instead.

The VM's bucket credentials can only write, so **a person** with a credential that may read fetches the newest dump and the identity copies from the same night, and copies them and the two age keys to the VM, into a new folder only you can read:

```bash
restore="$(mktemp -d)"
echo "$restore"
```

Then restore the dump as `migrator` in one transaction, so a failure leaves the database empty rather than half restored:

```bash
age --decrypt --identity "$restore/dumps-key.txt" "$restore/pbmb-2026-10-26T011500Z.dump.age" |
  docker compose -p pbmb exec -T postgres sh -c 'PGPASSWORD="$MIGRATOR_PASSWORD" exec pg_restore --host=127.0.0.1 --username=migrator --dbname=powerbi_metrics_book --exit-on-error --single-transaction'
```

Put each identity back into its own volume before the `api` and the `worker` first start, so neither makes a new one, then start everything:

```bash
for container in api worker; do
  age --decrypt --identity "$restore/identities-key.txt" "$restore/${container}_identity-2026-10-26T011500Z.tar.age" |
    docker compose -p pbmb run --rm -T --no-deps --entrypoint tar "$container" -x --keep-old-files -C /var/lib/pbmb
done
docker compose -p pbmb up -d --wait
```

Each `run` extracts the copy into the volume as the container's own user, `10001`, with the file's mode `0400` kept, and `--keep-old-files` refuses to replace an identity already there. Delete the `$restore` folder afterwards, keys and all.

Take the dump and the identities from the same night. An identity copy from before a rotation cannot read secrets encrypted after it: the `api` starts, but every secret written since the rotation is unreadable. A lost identity is not the end: the admin section lists the secrets to enter again, and people reconnect Power BI once.

## Rotating an identity

Each container's age identity decrypts the secrets it reads. To replace one, for the `api` or the `worker`:

```bash
docker compose exec api server rotate-identity
docker compose restart api
sudo systemctl start pbmb-backup.service
```

The command makes a new identity, encrypts every secret the container reads to it, and retires the old one. The restart makes the container use it, and the backup saves the new identity at once. Keep the older identity copies: they still open the dumps taken before the rotation.
