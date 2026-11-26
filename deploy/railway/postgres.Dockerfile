# Postgres for Railway: the pinned pgvector image of compose.yml, with the
# deployment's init script inside it, since Railway has no bind mounts. The
# script runs once, on an empty volume. Build context: the repository root.
FROM pgvector/pgvector:pg18-trixie@sha256:ab49524d18df7200b74ac9a475e1db6297fc1eb57da4c214c63d10ecc4b754fa
COPY postgres/init/ /docker-entrypoint-initdb.d/
