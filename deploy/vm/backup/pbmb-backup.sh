#!/usr/bin/env bash
# Backs up one running deployment, encrypts each file with age, and sends it
# off the machine with rclone:
#
# - a pg_dump of powerbi_metrics_book, encrypted to dumps.recipient, to the
#   remote in dumps.conf;
# - the api's and the worker's identity volumes, encrypted to
#   identities.recipient, to the remote in identities.conf.
#
# A dump holds every row in plain text except the secrets, which the database
# keeps encrypted to the identities. It is encrypted before it touches the
# disk, in a pipe. The dumps and the identities go to different places, each
# with its own credentials and its own age key: whoever holds both can read
# the secrets.
#
# Credentials should be write-only, and nothing here deletes: the buckets'
# lifecycle rules and object lock keep and expire the copies (the VM guide).
#
# The dump runs as migrator. setting_check and the secrets tables have
# row-level security, and pg_dump refuses a table whose rows a policy would
# hide from it; migrator owns every table, so no policy hides a row from it.
#
# Run by pbmb-backup.service, as root (it needs Docker). Settings come from
# /etc/pbmb-backup.env (backup.env.example), keys and remotes from
# /etc/pbmb-backup/. It finds the containers by their compose labels, so it
# works for a project started from any directory, as under Dokploy.
set -euo pipefail

: "${PBMB_PROJECT:?PBMB_PROJECT is not set: the compose project name, such as pbmb for /srv/pbmb}"
config=/etc/pbmb-backup

container_of() {
  local found
  found="$(docker ps --quiet \
    --filter "label=com.docker.compose.project=$PBMB_PROJECT" \
    --filter "label=com.docker.compose.service=$1")"
  if [[ -z "$found" || "$found" == *$'\n'* ]]; then
    echo "Expected one running $1 container in project $PBMB_PROJECT; found ${found:-none}." >&2
    exit 1
  fi
  echo "$found"
}

# Uploads one file to the remote named after its rclone config. The
# destination is never listed or read, so a write-only credential is enough.
send() {
  rclone copyto --config "$config/$1.conf" --no-check-dest --retries 1 \
    "$work/$2" "$1:$2"
}

postgres="$(container_of postgres)"
api="$(container_of api)"
worker="$(container_of worker)"

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# The password is the postgres container's own MIGRATOR_PASSWORD, read inside
# it, so it never appears on this machine's command line. The extensions are
# left out: the init script makes them on the server a dump is restored to,
# and migrator, which does not own them, could not restore their comments.
# Query results hold company data and are not kept in a backup: the two result
# tables dump empty, and the query log's DAX lets an agent run a query again.
docker exec "$postgres" sh -c \
  'PGPASSWORD="$MIGRATOR_PASSWORD" exec pg_dump --host=127.0.0.1 --username=migrator --dbname=powerbi_metrics_book --format=custom --exclude-extension="*" --exclude-table-data=query_result --exclude-table-data=query_result_page' |
  age --encrypt --recipients-file "$config/dumps.recipient" >"$work/pbmb-$stamp.dump.age"

# docker cp writes a tar of the directory, with its owner and modes.
for container in api worker; do
  docker cp "${!container}:/var/lib/pbmb/identity" - |
    age --encrypt --recipients-file "$config/identities.recipient" \
      >"$work/${container}_identity-$stamp.tar.age"
done

send dumps "pbmb-$stamp.dump.age"
send identities "api_identity-$stamp.tar.age"
send identities "worker_identity-$stamp.tar.age"

echo "Backed up $PBMB_PROJECT at $stamp."
