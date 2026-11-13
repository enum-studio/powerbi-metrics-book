# Postgres for Railway: the pinned pgvector image of compose.yml, with the
# deployment's init script inside it, since Railway has no bind mounts. The
# script runs once, on an empty volume. Build context: the repository root.
FROM pgvector/pgvector:pg18-trixie@sha256:5895949dfcdf308eb0cd31c950c93c14895c77f33fbedfecf1fa511ab1d4bcd2
COPY postgres/init/ /docker-entrypoint-initdb.d/
