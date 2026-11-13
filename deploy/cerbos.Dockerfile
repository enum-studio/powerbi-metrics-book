# Cerbos for Railway and Azure Container Apps: the pinned Cerbos image of
# compose.yml with its configuration, the default policies from the release
# image and the deployment's own policies built in, since neither platform has
# compose's image mounts. Build context: the deployment directory, or a copy
# of its cerbos/ and access/ folders. PBMB_IMAGE is the release image with its
# digest: Railway passes the service variable as a build ARG, and the Azure
# guide passes it to az acr build.
ARG PBMB_IMAGE
FROM ${PBMB_IMAGE} AS release

FROM ghcr.io/cerbos/cerbos:0.57.0@sha256:e5e3b150b3cb0090975605254f255164567d67e233634199fb20972e3eaff300
COPY cerbos/config.yaml /config/config.yaml
COPY --from=release /app/access/policies/ /policies/default/
COPY access/policies/ /policies/deployment/
# The upstream image runs as root; Cerbos needs no user of its own. Without
# compose's tmpfs mounts, /tmp is the one place it can write.
USER 10001:10001
ENV XDG_CACHE_HOME=/tmp
CMD ["server", "--config=/config/config.yaml"]
