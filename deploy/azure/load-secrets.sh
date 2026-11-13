#!/usr/bin/env bash
# Copies the bootstrap values from a deployment's .env into Key Vault, as the
# secrets main.bicep reads, and builds the four database URLs on the way.
#
#   bash load-secrets.sh <deployment directory> <key vault> <postgres server name>
#
# Each value goes to az through a file readable by you only, never on a
# command line, and nothing is printed. Run it again after a change to .env;
# the containers read the new values at their next revision.
set -euo pipefail

directory="${1:?the deployment directory pbmb init wrote}"
vault="${2:?the Key Vault name}"
server="${3:?the PostgreSQL server name}"
host="$server.postgres.database.azure.com"

# The value of the line NAME=value in .env. A plain function: macOS ships
# bash 3, which has no associative arrays.
value() { sed -n "s/^$1=//p" "$directory/.env" | tail -n 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

put() {
  printf '%s' "$2" >"$work/value"
  az keyvault secret set --vault-name "$vault" --name "$1" --file "$work/value" \
    --encoding utf-8 --output none
}

url() {
  printf 'postgres://%s:%s@%s:5432/powerbi_metrics_book?sslmode=verify-full' \
    "$1" "$(value "$2")" "$host"
}

for name in POSTGRES_PASSWORD MIGRATOR_PASSWORD API_RW_PASSWORD WORKER_RW_PASSWORD AUDIT_WRITER_PASSWORD AUTH_SECRET; do
  if [[ -z "$(value "$name")" ]]; then
    echo "$directory/.env has no value for $name. Run pbmb check $directory." >&2
    exit 1
  fi
done

put postgres-password "$(value POSTGRES_PASSWORD)"
put migrator-password "$(value MIGRATOR_PASSWORD)"
put api-rw-password "$(value API_RW_PASSWORD)"
put worker-rw-password "$(value WORKER_RW_PASSWORD)"
put audit-writer-password "$(value AUDIT_WRITER_PASSWORD)"
put auth-secret "$(value AUTH_SECRET)"
put api-database-url "$(url api_rw API_RW_PASSWORD)"
put worker-database-url "$(url worker_rw WORKER_RW_PASSWORD)"
put migrator-database-url "$(url migrator MIGRATOR_PASSWORD)"
put audit-database-url "$(url audit_writer AUDIT_WRITER_PASSWORD)"
# Only with identitiesFromKeyVault=true; the guide says how to make them.
for container in API WORKER; do
  identity="$(value "${container}_AGE_IDENTITY")"
  if [[ -n "$identity" ]]; then
    put "$(echo "$container" | tr '[:upper:]' '[:lower:]')-age-identity" "$identity"
  fi
done

echo "Loaded the bootstrap values into $vault."
