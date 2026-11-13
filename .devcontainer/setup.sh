#!/usr/bin/env bash
# Sets up a checkout for development: pnpm (through corepack, at the version
# package.json names), uv, then the Node and Python dependencies from the
# lockfiles. The devcontainer runs it once the container exists, and it is the
# install step of a Cursor cloud agent's environment. Run it again any time: it
# installs only what is missing.
set -euo pipefail

UV_VERSION=0.12.8

say() {
  printf 'setup.sh: %s\n' "$*" >&2
}

have() {
  command -v "$1" > /dev/null 2>&1
}

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repository_root"

if ! have node; then
  say "Node 24 is required and none is installed."
  exit 1
fi
node_major=$(node --print 'process.versions.node.split(".")[0]')
if [ "$node_major" != "24" ]; then
  say "Node 24 is required, this is Node $node_major."
  exit 1
fi

# pip --user and corepack put their tools here, which a fresh shell may not
# have on its PATH yet. Installing there also works when Node is owned by root.
bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"
export PATH="$bin_dir:$PATH"

# Corepack asks before it downloads pnpm, and nobody answers inside this
# script, so it is told not to ask.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! have pnpm; then
  say "Enabling pnpm through corepack."
  corepack enable --install-directory "$bin_dir" pnpm
fi

if ! have uv; then
  say "Installing uv $UV_VERSION."
  python3 -m pip install --user "uv==$UV_VERSION"
fi

say "Installing Node dependencies."
pnpm install --frozen-lockfile
say "Installing Python dependencies."
uv sync --locked
say "Done."
