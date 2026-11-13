---
title: Azure Container Apps
description: For a company that already runs Power BI in Azure. One Bicep template makes the Container Apps, PostgreSQL Flexible Server, the registry for Cerbos and the Key Vault references.
sidebar:
  order: 4
---

A company that runs Power BI usually has an Azure subscription already. `deploy/azure/main.bicep` makes the whole stack in one resource group, and this guide ends with `pbmb admin status` passing against the new address. Each step says who acts: **you**, or **a person** with a right you may not have.

:::note
This guide has not been followed on a real account yet, so report where it differs.
:::

What the template makes:

- A Container Apps environment in its own subnet, logging to Log Analytics.
- The `api` with external ingress, the `worker` with none, and Cerbos with internal ingress, which only the environment's apps reach. The `api` and the `worker` run the release image `ghcr.io/enum-studio/powerbi-metrics-book:<version>`, pinned by digest. Cerbos runs an image you build into the template's registry in step 6, with your policies inside, as user `10001`.
- Azure Database for PostgreSQL Flexible Server 18, reachable only from the virtual network, with the `vector` and `pg_trgm` extensions allowed.
- A managed identity each for the `api`, the `worker` and the `database-init` job. Each may read only the Key Vault secrets it names, through one role assignment per secret. Only `database-init` reads `postgres-password`. Microsoft's [Key Vault RBAC guide](https://learn.microsoft.com/azure/key-vault/general/rbac-guide) prefers a vault per application; one vault keeps one place to load and audit, and `audit-database-url`, which the `api` and the `worker` share, is the case that page allows.
- A storage account holding only the two identity shares, which refuses every network but the apps subnet.

## What you need

- **A person** with the Owner role on the subscription does three things once: registers the providers, creates the resource group, and gives you two roles on that group only. They are `Contributor` and `Role Based Access Control Administrator`, the second limited to assigning `Key Vault Secrets User`, `Key Vault Secrets Officer` and `AcrPull` ([constrain roles](https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-portal)).

  ```bash
  az provider register --namespace Microsoft.App --wait
  az provider register --namespace Microsoft.DBforPostgreSQL --wait
  az provider register --namespace Microsoft.ContainerRegistry --wait
  az group create --name pbmb --location westeurope
  ```

- The Azure CLI 2.91 or newer, signed in with `az login`, and `pbmb` from the `powerbi-metrics-book` package on PyPI at the release's version (`uv tool install powerbi-metrics-book==0.1.0`); `git`, for `git ls-remote` in step 1; and `jq`.
- **A person** who can add DNS records for the address people will open.

Set these once in your shell. The vault and server names must be unused in all of Azure.

```bash
PBMB_VERSION=0.1.0
RG=pbmb
LOCATION=westeurope
VAULT=pbmb-vault-example
SERVER=pbmb-db-example
```

## 1. The deployment directory

```bash
pbmb init ./pbmb-deployment --public-base-url https://metrics.example.com
cd ./pbmb-deployment
COMMIT="$(git ls-remote https://github.com/enum-studio/powerbi-metrics-book "refs/tags/v$PBMB_VERSION" "refs/tags/v$PBMB_VERSION^{}" | tail -n 1 | cut -f 1)"
echo "$COMMIT"
base="https://raw.githubusercontent.com/enum-studio/powerbi-metrics-book/$COMMIT/deploy"
for file in azure/main.bicep azure/main.parameters.json azure/load-secrets.sh azure/postgres-roots.pem cerbos.Dockerfile; do
  curl -fsSLO "$base/$file"
done
pbmb check .
```

`git ls-remote` asks GitHub which commit the tag `v0.1.0` names, and the files come from that commit, so they cannot change under you if the tag moves. To check it, compare the printed commit with the one on the release's GitHub page. The template reads `postgres/init/` from this folder, so it must sit here.

## 2. The Key Vault

```bash
az keyvault create --name "$VAULT" --resource-group "$RG" --location "$LOCATION" \
  --enable-rbac-authorization true --enabled-for-template-deployment true --enable-purge-protection true
az role assignment create --role "Key Vault Secrets Officer" \
  --assignee "$(az ad signed-in-user show --query id --output tsv)" \
  --scope "$(az keyvault show --name "$VAULT" --query id --output tsv)"
bash load-secrets.sh . "$VAULT" "$SERVER"
```

Purge protection keeps a deleted secret for 90 days, and nobody can purge it sooner. `load-secrets.sh` copies the values from `.env` into the vault without printing them, and builds the four database URLs for `$SERVER`. A new role assignment can take a few minutes to apply; if the script is refused, wait and run it again.

## 3. The parameters

Edit `main.parameters.json`:

| Parameter | Value |
|---|---|
| `image` | the image line in `compose.yml`, from `grep 'image: &image' compose.yml`: `ghcr.io/enum-studio/powerbi-metrics-book:<version>@sha256:<digest>` |
| `publicBaseUrl` | `https://metrics.example.com` |
| `keyVaultName` | `$VAULT` |
| `postgresServerName` | `$SERVER` |
| `postgresAdminPassword` | the vault's id, from `az keyvault show --name "$VAULT" --query id --output tsv`, in the `reference` block |

Leave `cerbosDigest` empty for now. The other parameters have defaults: the address ranges (`10.40.0.0/16`, with the apps in `10.40.0.0/23`) and `identitiesFromKeyVault` (below).

## 4. The first deployment

```bash
az deployment group create --resource-group "$RG" --template-file main.bicep --parameters @main.parameters.json
```

With `cerbosDigest` empty, the template makes everything except the three apps: they need the database and the Cerbos image of the next two steps. It takes 10 to 15 minutes, most of it the database server.

## 5. The database

The `database-init` job runs `postgres/init/01_roles_and_database.sh` once, inside the virtual network: it makes the four roles, the database and its extensions.

```bash
az containerapp job start --name pbmb-database-init --resource-group "$RG"
az containerapp job execution list --name pbmb-database-init --resource-group "$RG" --query "[0].properties.status" --output tsv
```

Run the second command until it prints `Succeeded`. The job checks the server's certificate and name (`verify-full`) against Azure's two root certificates in `postgres-roots.pem`, from [TLS for Azure Database for PostgreSQL](https://learn.microsoft.com/azure/postgresql/security/security-tls); its image has no certificate store of its own. Flexible Server's admin is not a superuser, so the job sets `createrole_self_grant` for its session: the admin may then hand the database to `migrator`. Only extensions in the server's `azure.extensions` list can be created, which the template sets ([allow extensions](https://learn.microsoft.com/azure/postgresql/extensions/how-to-allow-extensions)).

## 6. The Cerbos image

Container Apps cannot mount a file from an image, so Cerbos gets its configuration and policies built in. The build context is a new folder holding only what the image needs, so `.env` never leaves your machine:

```bash
REGISTRY="$(az deployment group show --resource-group "$RG" --name main --query properties.outputs.registry.value --output tsv)"
context="$(mktemp -d)"
cp -R cerbos access cerbos.Dockerfile "$context/"
az acr build --registry "$REGISTRY" --image "pbmb-cerbos:$PBMB_VERSION" --file cerbos.Dockerfile \
  --build-arg "PBMB_IMAGE=$(sed -n 's/^ *image: &image //p' compose.yml)" "$context"
rm -r "$context"
az acr repository show --name "$REGISTRY" --image "pbmb-cerbos:$PBMB_VERSION" --query digest --output tsv
```

Put the digest the last command prints, `sha256:...`, into `main.parameters.json` as `cerbosDigest`. Cerbos runs that exact build, pulled with its own identity, which has `AcrPull` on this registry only.

## 7. The apps

```bash
az deployment group create --resource-group "$RG" --template-file main.bicep --parameters @main.parameters.json
az deployment group show --resource-group "$RG" --name main --query properties.outputs.apiAddress.value --output tsv
```

The deployment ends when Cerbos, the `api` and the `worker` are running. The second command prints the `api`'s own address, `https://pbmb-api.<random>.<region>.azurecontainerapps.io`.

## 8. The address

To serve `metrics.example.com` instead, from [custom domains with managed certificates](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates):

```bash
az containerapp show --name pbmb-api --resource-group "$RG" --query "[properties.configuration.ingress.fqdn, properties.customDomainVerificationId]" --output tsv
```

**A person** adds two DNS records: a `CNAME` from `metrics` to the first value, and a `TXT` record `asuid.metrics` holding the second. Then:

```bash
az containerapp hostname add --hostname metrics.example.com --name pbmb-api --resource-group "$RG"
az containerapp hostname bind --hostname metrics.example.com --name pbmb-api --resource-group "$RG" \
  --environment pbmb-environment --validation-method CNAME
az containerapp env certificate list --name pbmb-environment --resource-group "$RG" --managed-certificates-only --query "[0].id" --output tsv
```

Put the id the last command prints into `main.parameters.json` as `certificateId`. A later deployment then keeps the binding instead of removing it.

## 9. The setup link and the check

```bash
az containerapp exec --name pbmb-api --resource-group "$RG" --command "server setup-link"
```

The link is printed by the command, not in the log. It works once, for 24 hours. Open it and follow the [Set up](/docs/set-up/) part. Then, on your own machine:

```bash
pbmb login --url https://metrics.example.com
pbmb admin status
```

`pbmb login` prints a code; **a person** opens the address it names in a browser, enters the code and signs in. `pbmb admin status` answers, and any check it lists as failing says what to change: a secret saved without its expiry date is one.

## TRUSTED_PROXY

The template sets `TRUSTED_PROXY` to the apps subnet, `10.40.0.0/23`, and this is not confirmed by Microsoft's documentation. Container Apps' ingress adds the client's address as the rightmost `X-Forwarded-For` entry ([ingress headers](https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers)), and it runs inside the environment, but Microsoft's pages do not name the address it connects from.

Check it once you are signed in: send a made-up address and see what the `api` reports.

```bash
pbmb whoami
jq -r '"Authorization: Bearer " + .access_token' "${XDG_CONFIG_HOME:-$HOME/.config}/pbmb/credentials.json" |
  curl -sS -H @- -H 'X-Forwarded-For: 192.0.2.1' https://metrics.example.com/api/v1/me | jq -r .client_address
curl -sS https://ifconfig.me
```

`pbmb whoami` refreshes your login, and the token goes to `curl` on its standard input, never on a command line. The first address should match the second, your own public address.

- `192.0.2.1`: the ingress passed your header on without adding your address, so anyone could pick the address their sign-ins count against. Add `trustedProxy` with an empty value to `main.parameters.json` and deploy again as in step 7; every sign-in then shares one limit.
- A private address, such as one starting with `10.` or `100.`: the ingress connects from outside the subnet, the `api` did not trust it, and every sign-in shares one limit.

In either case, open an issue with the address you see.

## Outbound traffic

The apps subnet can reach the whole internet, and the template leaves it so. The `api` and the `worker` call Entra ID, Microsoft Graph, the Power BI API and the embedding provider (OpenAI or Gemini), and pull the release image from `ghcr.io`. A network security group filters by address and service tag, and Graph, the embedding providers and `ghcr.io` have none, so it would have to allow port 443 everywhere ([network security groups](https://learn.microsoft.com/azure/container-apps/firewall-integration)). Closing it takes Azure Firewall with host name rules and a route table on the apps subnet ([user defined routes](https://learn.microsoft.com/azure/container-apps/user-defined-routes)), a separate resource billed by the hour.

## What Container Apps does not offer

A container app runs with the platform's own settings: Container Apps has no setting for a read-only root file system or for dropping Linux capabilities, for any app ([container apps template](https://learn.microsoft.com/azure/templates/microsoft.app/containerapps)), both of which `compose.yml` sets on a VM. The `api`, the `worker` and Cerbos still run as user `10001`. The `database-init` job runs as root in the pgvector image, for the few seconds it takes to make the roles.

## Identities: Azure Files or Key Vault

By default each container keeps its age identity in its own Azure Files share, as on a VM. `server rotate-identity` works, and the shares need their own backup (below). The storage account accepts connections from the apps subnet only. It still allows its account key, which the share mounts use: mounting with a managed identity instead is in preview ([storage mounts](https://learn.microsoft.com/azure/container-apps/storage-mounts)).

With `identitiesFromKeyVault: true`, each identity comes from the vault as `API_AGE_IDENTITY` or `WORKER_AGE_IDENTITY`, and no storage account is made. The vault keeps old versions and logs every read. The trade-off: `rotate-identity` refuses, because it replaces the file only, so a new identity means entering that container's secrets again. To use it, add each identity to `.env` before step 2 as `API_AGE_IDENTITY=AGE-SECRET-KEY-1...`, made with `age-keygen` from [age](https://github.com/FiloSottile/age), and `load-secrets.sh` copies them.

## Backups

Flexible Server backs up the database itself, kept 14 days, with restore to any point in that time, query results included, which are at most 72 hours old at any point ([backup and restore](https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore)). Back up the `api-identity` and `worker-identity` shares apart from it with Azure Backup for Azure Files, in a vault other people administer than the database's: every secret in the database is encrypted to those identities. Azure Backup reaches the shares through the storage firewall's exception for trusted Azure services, which the template turns on ([back up Azure Files](https://learn.microsoft.com/azure/backup/backup-azure-files)); everything else must come from the apps subnet.

## Upgrading

Run `pbmb init` of the new version into a new folder made with `mktemp -d`. Take its image line into `main.parameters.json` and its `postgres/` and `cerbos/` into this folder, fetch the new files as in step 1, build Cerbos again as in step 6, and deploy as in step 7.

**Upgrading from any release before database migration `0003`** (invites and deactivation): the old and the new `api` must not serve at once. Container Apps keeps the old revision serving until the new one is ready, and runs up to 3 replicas, so for a short while both run. The old one still gives an invite's role when it sends the invite, and can still accept an invite with a password. The old one also ends invites in a way the new one reads only at its start, and migration `0004` removes that record, so take a release with `0003` and without `0004` first and let it start. A later release refuses to start until that one has, and says so. For this upgrade, deactivate the `api`'s active revision first, then deploy as in step 7. Sign-in and the connector are down until the new revision is ready, usually under a minute.

```bash
az containerapp revision list --name pbmb-api --resource-group "$RG" --query "[?properties.active].name" --output tsv
az containerapp revision deactivate --name pbmb-api --resource-group "$RG" --revision <the name it printed>
```

After a change to `access/policies/`, build Cerbos again, put the new digest in `cerbosDigest`, and deploy.

An upgrade of the Postgres server itself restarts nothing here. Restart the api's revision afterwards, as under Rotating an identity, and that start rebuilds the indexes that depend on it. If it stops with `Two rows share a key in`, follow the VM guide's Upgrading section from inside the virtual network, since the server takes no public connections.

## Rotating an identity

```bash
az containerapp exec --name pbmb-api --resource-group "$RG" --command "server rotate-identity"
az containerapp revision restart --name pbmb-api --resource-group "$RG" \
  --revision "$(az containerapp show --name pbmb-api --resource-group "$RG" --query properties.latestRevisionName --output tsv)"
```

The same works for `pbmb-worker`.
