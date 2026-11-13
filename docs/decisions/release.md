# Releasing

A pushed tag `v*` runs `.github/workflows/release.yml`. It publishes the
image to GHCR, signed and with its SBOM, the CLI to PyPI, and a GitHub
release holding the compose file and the command that verifies the image.

## The tag, the CLI and the API must agree

**`check` stops the release unless the tag is `v` plus the version in
`apps/cli/pyproject.toml` and in `apps/api/package.json`.**

Why: the image tag, the wheel and the API's reported version are one number
in three places, and a release that disagrees with itself cannot be told
apart afterwards. `apps/api/src/version.ts` exports the `version` of
`package.json` and holds no number of its own, so that field is compared.
The tag holds letters, digits, dots and hyphens only (Docker tags).

## Nothing is built until a reviewer approves

**`check` runs in the environment `release` and every other job needs it, so
one approval comes before anything is built or pushed.** `publish_cli` has
its own environment, `pypi`, which asks again before the upload.

## A version is released once

**`build_image` fails if `ghcr.io/enum-studio/powerbi-metrics-book:<version>`
already exists.** It lists the package's versions through the GitHub API
and fails if one carries the tag. It goes on without a match only when the
API answers 404 (no package yet); any other error stops it, because a
network failure must not look like a free version. PyPI refuses a version
twice, so do not re-run a release after it has published anything: bump the
version.

## Why keyless signing

**The image is signed by digest with cosign and no key: GitHub's OIDC token
for the run proves who signed, and Sigstore records it.**

Why: a signing key has to be stored, rotated and kept out of the workflow's
reach, and the day it leaks every signature is in doubt. Keyless has nothing
to store. The certificate names the workflow, the tag ref, the commit and
the trigger, so a verifier checks facts it can read:

```
cosign verify ghcr.io/enum-studio/powerbi-metrics-book@sha256:<digest> \
  --certificate-identity https://github.com/enum-studio/powerbi-metrics-book/.github/workflows/release.yml@refs/tags/v<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-sha <commit> \
  --certificate-github-workflow-repository enum-studio/powerbi-metrics-book \
  --certificate-github-workflow-trigger push
```

The release notes carry it filled in. The commit binds the signature to the
code built; signing the digest, not the tag, survives a moved tag.

**The SBOM is the one buildx attaches, and the signature covers it.** With
`sbom: true` and `provenance: mode=max`, buildx puts an SBOM and a
provenance attestation per platform inside the image index; signing the
index digest signs them. There is no second scanner and no `cosign attest`.

Why two jobs: `build_image` runs third-party build code and holds
`packages: write` but no `id-token`, so nothing it runs can ask for a signing
identity. `sign_image` holds both and runs only cosign (install, `sign`,
`verify`), so a release whose signature does not verify never reaches PyPI.
The cost: verifying needs the Sigstore public services.

## Why GHCR and PyPI

**The image lives on `ghcr.io`, the CLI on PyPI.** GHCR needs no credential
beyond the run's own `GITHUB_TOKEN`. People already install Python command
line tools from PyPI, and `pbmb init` is the first thing they run. PyPI
trusts the workflow and its `pypi` environment, so no API token exists.

## The CLI pins the image it was released with

**`pbmb init` runs the image by digest, read from
`apps/cli/src/powerbi_metrics_book/assets/image.lock`. That file is not
committed; the release workflow writes it.**

`build_cli` runs after the image is pushed and signed. It takes the digest
from `build_image`'s outputs, checks its shape, writes `image.lock`, and only
then runs `uv build`. It fails unless the wheel's copy equals the digest, and
`publish_cli` repeats that before uploading. Hatchling packages everything
under `src/powerbi_metrics_book`, so the file lands in the wheel with no
packaging setting (checked with a throwaway digest). A wheel built elsewhere
has no `image.lock`, and `pbmb init` then needs `--image`. Keep `image.lock`
out of `.gitignore`: hatchling silently leaves out what Git ignores.

The release's `compose.yml` comes from the CLI's own `compose_text` with
`ghcr.io/enum-studio/powerbi-metrics-book:<version>@<digest>`, so it cannot
drift from what `pbmb init` writes. `build_cli` makes it, in a job that can
write nothing, and hands it on as an artifact, so the `release` job, which
can write to the repository, runs no package code; it only checks that the
file names the digest. The project runs from source, not installed, because
installing it builds it with an unhashed hatchling (`uv run` ignores
`UV_BUILD_CONSTRAINT`).

## What is kept small and pinned

Every action is pinned by full commit SHA, each a release at least two weeks
old when chosen. `contents: write` is only in the release job, `packages:
write` only where the image is pushed or signed, `id-token: write` only in
the signing and PyPI jobs. Checkouts keep no credentials, and the setup
actions for uv, QEMU and Buildx have their caches off. `tonistiigi/binfmt`
and `moby/buildkit` are pinned by digest. The wheel is built with the hashed
requirements in `apps/cli/build-constraints.txt` and `--require-hashes`.

To refresh:

- **Actions.** The commit of the newest release at least two weeks old, from
  the action's own repository (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`,
  following an annotated tag).
- **Builders.** `docker buildx imagetools inspect <image>:<tag>` prints the digest.
- **Build constraints.** `echo "hatchling==<version>" | uv pip compile -
  --generate-hashes --exclude-newer <yesterday> --no-header -o
  apps/cli/build-constraints.txt`, keep the two comment lines at its top, and
  set the same version in `build-system.requires` of `apps/cli/pyproject.toml`.

## Before the first release

Martin sets these up once. The first two are required: without them any
tag pusher can release.

1. **The `release` and `pypi` environments** (settings, Environments). On
   both: deployment tags limited to `v*`, and a required reviewer.
2. **A tag ruleset on `v*`** (settings, Rules, Rulesets, target tags):
   creation limited to the maintainers, and update and deletion blocked for
   everyone. The signature names the tag, so a movable tag lets a different
   commit carry the same name.
3. **PyPI.** The project does not exist yet, so add a pending trusted
   publisher at pypi.org (Your account, Publishing): project
   `powerbi-metrics-book`, owner `enum-studio`, repository
   `powerbi-metrics-book`, workflow `release.yml`, environment `pypi`.
4. **The image's visibility on GHCR.** A package pushed from a private
   repository starts private, and `pbmb init` cannot pull it without a login.
   Once the repository is public, open the package
   (`github.com/orgs/enum-studio/packages`), connect it to the repository,
   set it to public, and `docker pull` it logged out.
5. **The first tag.** Set both versions, merge, tag the commit
   (`git tag v0.1.0 && git push origin v0.1.0`) and approve the run.

## When the repository goes public

**The release gates and the repository's protections are set right after
the repository goes public, because GitHub offers them only then.** On
2026-11-12 the repository was private on GitHub's free plan: the rulesets
and branch protection endpoints answered 403 ("make this repository public
to enable this feature"), private vulnerability reporting answered 404, and
the repository had no environments. Until step 1 below is done, a pushed
`v*` tag runs `release.yml` with no reviewer, and GitHub creates the
`release` environment unprotected on that run. Martin sets these in the
repository's settings, in this order:

1. **The release gates**: steps 1 and 2 of "Before the first release", the
   `release` and `pypi` environments with a required reviewer and the `v*`
   tag ruleset. Until they exist, push no `v*` tag.
2. **A branch ruleset on `main`** (Rules, Rulesets, target the default
   branch): a pull request with one approval and a code owner's review, the
   check `gate` passing (the job in `merge-gate.yml`), and no force push or
   deletion. The Repository admin role goes on the bypass list, because the
   only code owner cannot approve a pull request they opened. Until the ruleset
   exists, `CODEOWNERS` names a reviewer but blocks nothing.
3. **Approval for outside contributors' workflows** (Actions, General, Fork
   pull request workflows): "Require approval for all external
   contributors". `merge-gate` runs on `pull_request` with a read-only token
   and no secrets, so a fork gains nothing from it, but it still runs the
   fork's code on a runner.
4. **SHA pinning** (Actions, General): require actions pinned to a full
   commit SHA. Every workflow already pins this way; the setting keeps it so.
5. **Private vulnerability reporting, secret scanning with push protection,
   and Dependabot alerts** (Security). The report link in `SECURITY.md` and
   on the docs' reporting page answers 404 until the first is on.
6. **About**: the website `https://powerbimetricsbook.io`, and topics such
   as `power-bi`, `mcp`, `metrics`, `semantic-layer` and `dax`.

Step 4 of "Before the first release", the image's visibility on GHCR,
follows at the first release. This stops being right if the repository
moves to a paid plan while still private, where rulesets and environment
reviewers exist already; nothing checks it, so the list is read once, at
the switch.
