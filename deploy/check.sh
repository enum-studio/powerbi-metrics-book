#!/usr/bin/env bash
# Checks the deploy guides' files and the sample deployment without starting
# anything: compose's dry run over a deployment pbmb init writes, the port
# rule, Caddy's and Bicep's own validators, and pbmb check on the sample.
# Needs Docker, uv and the network (images, and the Bicep CLI).
#
#   bash deploy/check.sh
#
# Never `docker compose config`: it prints the resolved secrets.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="$(cd "$here/.." && pwd)"
assets="$repository/apps/cli/src/powerbi_metrics_book/assets"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

azure_cli_image="mcr.microsoft.com/azure-cli:2.91.0@sha256:933eb8dcb81aecb6f77e03c5b8660f0a1dfa9e1d16525763a27f86ff3b83a044"
bicep_version="v0.48.1"

step() { echo "> $1"; }
# Runs a command quietly, and shows its output only when it fails.
quiet() {
  if ! "$@" >"$work/output" 2>&1; then
    cat "$work/output"
    echo "Failed: $*" >&2
    exit 1
  fi
}
# The first image reference in a file that starts with $1 and has a digest.
pinned() {
  local found
  found="$(sed -En "s|^ *image: (&image )?($1[^ ]*@sha256:[0-9a-f]{64})$|\2|p" "$2" | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "No image pinned by digest that starts with $1 in $2." >&2
    exit 1
  fi
  echo "$found"
}
pbmb() { uv run --project "$repository" --quiet pbmb "$@"; }
ports_rule() { uv run --project "$repository" --quiet python "$here/published_ports.py" "$@"; }

cerbos_image="$(pinned ghcr.io/cerbos/cerbos: "$assets/compose.yml")"
caddy_image="$(pinned caddy: "$here/vm/compose.caddy.yml")"

# compose resolves every image, including the one cerbos mounts its default
# policies from. The release image does not exist before a release, so the
# deployment checked here pins the Cerbos image, present after this pull, in
# its place: the dry run checks the files' shape, not what an image holds.
step "a deployment from pbmb init"
quiet docker pull --quiet "$cerbos_image"
deployment="$work/deployment"
quiet pbmb init "$deployment" --public-base-url https://metrics.example.com --image "$cerbos_image"
cp "$here/vm/compose.caddy.yml" "$here/vm/Caddyfile" "$here/dokploy/compose.dokploy.yml" \
  "$here/azure/main.bicep" "$here/azure/main.parameters.json" "$here/azure/postgres-roots.pem" "$deployment/"

dry_run() {
  local directory="$1"
  shift
  quiet docker compose --project-directory "$directory" -p pbmbcheck \
    --env-file "$directory/.env" "${@/#/--file=$directory/}" --dry-run create
}

step "VM: compose.caddy.yml, dry run"
dry_run "$deployment" compose.yml compose.caddy.yml
step "VM: only caddy publishes a port"
quiet ports_rule "$deployment/compose.yml" "$deployment/compose.caddy.yml" caddy
# The rule must catch the mistake it exists for: the overlay without its
# reset leaves the api's port published.
grep -v 'ports: !reset \[\]' "$here/vm/compose.caddy.yml" >"$work/api-publishes.yml"
if ports_rule "$deployment/compose.yml" "$work/api-publishes.yml" caddy >/dev/null; then
  echo "The port rule passed an overlay where the api still publishes its port." >&2
  exit 1
fi

step "VM: caddy validate"
quiet docker run --rm --network none --env PUBLIC_BASE_URL=https://metrics.example.com \
  --volume "$here/vm/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

step "VM: backup script syntax"
quiet bash -n "$here/vm/backup/pbmb-backup.sh"

step "Dokploy: compose.dokploy.yml, dry run, no published port"
dry_run "$deployment" compose.yml compose.dokploy.yml
quiet ports_rule "$deployment/compose.yml" "$deployment/compose.dokploy.yml"

step "Azure: az bicep build, no warnings"
quiet bash -n "$here/azure/load-secrets.sh"
# Bicep warns on stderr whenever a newer release is out, which is not a warning
# about main.bicep, so the pinned version does not look for one.
quiet docker run --rm --volume "$deployment:/deployment:ro" --workdir /deployment \
  --env AZURE_BICEP_CHECK_VERSION=false \
  "$azure_cli_image" sh -c "az bicep install --version $bicep_version >/dev/null 2>&1 &&
    az bicep build --file main.bicep --stdout >/dev/null 2>/tmp/build.log; status=\$?;
    cat /tmp/build.log; [ \$status -eq 0 ] && ! grep -q . /tmp/build.log"

step "Railway: railway.ts typechecks against the pinned railway package"
mkdir -p "$work/railway/.railway"
cp "$here/railway/package.json" "$here/railway/package-lock.json" "$work/railway/"
cp "$here/railway/railway.ts" "$work/railway/.railway/"
# From inside the folder: with --prefix, npm still reads this repository's
# .npmrc, made for pnpm, and refuses the lockfile.
(cd "$work/railway" && quiet npm ci --ignore-scripts --no-audit --no-fund)
quiet "$work/railway/node_modules/.bin/tsc" --noEmit --strict --module nodenext \
  --moduleResolution nodenext --target es2022 "$work/railway/.railway/railway.ts"

step "Railway and Azure: the same Cerbos, Postgres and Caddy images as compose.yml and the VM overlay"
postgres_image="$(pinned pgvector/pgvector: "$assets/compose.yml")"
for pin in "$cerbos_image:$here/cerbos.Dockerfile" "$postgres_image:$here/railway/postgres.Dockerfile" \
  "$postgres_image:$here/azure/main.bicep" "$caddy_image:$here/railway/railway.ts"; do
  if ! grep -qF "${pin%:*}" "${pin##*:}"; then
    echo "${pin##*:} does not pin ${pin%:*}, as compose.yml does." >&2
    exit 1
  fi
done

step "sample: the files pbmb init writes are unchanged"
sample="$repository/examples/sample"
quiet pbmb init "$work/sample-init" --image "$(pinned ghcr.io/enum-studio/powerbi-metrics-book: "$sample/compose.yml")"
rm "$work/sample-init/.env"
for written in $(cd "$work/sample-init" && find . -type f); do
  # The sample overrides drafting hints; pbmb check validates its conventions.
  [ "$written" = "./conventions.yml" ] && continue
  quiet diff "$work/sample-init/$written" "$sample/$written"
done

step "sample: compose.mock.yml, dry run"
cp -R "$sample" "$work/sample"
cp "$sample/env.example" "$work/sample/.env"
chmod 600 "$work/sample/.env"
# The copy is outside the checkout, so name the checkout the images build from.
export PBMB_REPOSITORY="$repository"
dry_run "$work/sample" compose.yml compose.mock.yml

step "sample: pbmb check"
quiet pbmb check "$work/sample"

echo "deploy/check.sh: every check passed."
