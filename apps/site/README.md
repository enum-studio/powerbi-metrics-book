# powerbimetricsbook.io

The project's public website: the landing page at `/` (this app) and the docs at `/docs/` (`apps/docs`, built for the site). One command builds both into `dist/`. `Dockerfile` here builds the same thing into an image, where Caddy serves it on port 8080, and Dokploy runs that image. The design and its reasons are in [docs/specs/2026-10-27-website.md](../../docs/specs/2026-10-27-website.md).

## Build and look at it

You need Node 24 and pnpm 11, as for the rest of the repository.

```bash
pnpm install
pnpm --filter @powerbi-metrics-book/site build
pnpm --filter @powerbi-metrics-book/site check
```

`build` builds the docs with `PBMB_DOCS_SITE=1`, then the landing page, then copies the docs into `dist/docs/`. `check` fails when one of these breaks:
- a link on the landing page;
- a link in the docs;
- a page without a link to the GitHub repository.

`pnpm --filter @powerbi-metrics-book/site dev` serves the landing page alone, without the docs. To serve the whole site the way it runs live, build the image from the repository root and run it:

```bash
docker build -f apps/site/Dockerfile -t powerbimetricsbook .
```

```bash
docker run --rm -p 8080:8080 powerbimetricsbook
```

Then open http://localhost:8080. The image runs `check` as it builds, so a broken link fails the build.

## How it is served

`Caddyfile` here decides what a visitor gets:
- `/docs/set-up` redirects to `/docs/set-up/`, as the site's links are written;
- a missing page answers `404` with the nearest 404 page: the docs' own under `/docs`, the landing page's everywhere else;
- `www.powerbimetricsbook.io` redirects to `powerbimetricsbook.io`;
- the files under `/_astro/` and `/docs/_astro/` are cached for a year, because their names change with their content.

## Where it runs

Dokploy, on the same server as Enum Studio's other sites:

| Setting | Value |
| --- | --- |
| Project, application | `powerbi-metrics-book`, `powerbi-metrics-book-web` |
| Source | GitHub, `enum-studio/powerbi-metrics-book`, branch `main` |
| Build | Dockerfile `apps/site/Dockerfile`, Docker context path `.` |
| Deploys | on every push to `main` that changes a watched path |
| Watched paths | `apps/site/**`, `apps/docs/**`, `packages/tokens/**`, `CHANGELOG.md`, `SECURITY.md`, `docs/security/threat_model.md`, `pnpm-lock.yaml` |
| Domains | `powerbimetricsbook.io` and `www.powerbimetricsbook.io`, port 8080, HTTPS with Let's Encrypt |

The watched paths are everything the build reads, so a push that changes only the api or the CLI does not rebuild the site.

The Docker context path must be `.`, the repository root. Dokploy reads an empty context path as the Dockerfile's own folder, `apps/site`, and the build then fails in seconds because `pnpm-lock.yaml` and the docs are not in it.

The DNS is in Cloudflare: an `A` record for `powerbimetricsbook.io` and one for `www`, both pointing at the server, not proxied. Traefik in Dokploy gets the certificates.

The site has no secrets and no environment variables.

## Before it goes public

Every GitHub link on the site, on every page, answers 404 to a visitor while the repository is private. Once it is public, check the links logged out:

```bash
for p in "" /blob/main/CONTRIBUTING.md /blob/main/LICENSE /issues/new/choose; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "https://github.com/enum-studio/powerbi-metrics-book$p"
done
curl -s -o /dev/null -w "%{http_code} metrics-book\n" https://github.com/enum-studio/metrics-book
```

Each answers `200`, except the last until Metrics Book goes public. It is the sister product that the landing page and the README link to, marked "(coming soon)" in both. Once it answers `200`, remove the two marks. The settings to make on the repository at the same time are in [docs/decisions/release.md](../../docs/decisions/release.md), under "When the repository goes public".

## Check

```bash
curl -sI https://powerbimetricsbook.io/ | head -1
curl -sI https://powerbimetricsbook.io/docs/ | head -1
curl -sI https://powerbimetricsbook.io/docs/set-up | grep -i -E '^(HTTP|location)'
curl -sI https://powerbimetricsbook.io/no-such-page | head -1
```

The first two answer `200`. The third answers a redirect to `/docs/set-up/`, and the last answers `404`, with the landing page's 404 page as its body.

## Release notes

Edit the repository's `CHANGELOG.md` for each release. The docs build copies it to `/docs/reference/changelog/`, which the site's header and footer link to.

Keep pending changes under `Unreleased`. Move them under the release's version when it ships, with any upgrade notes.
