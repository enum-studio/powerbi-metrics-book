# This deployment

<!-- powerbi-metrics-book:begin -->
`pbmb init` wrote this block. Write your own notes below it.

- Start: `docker compose up -d` here, after `PUBLIC_BASE_URL` in `.env` is the
  https address of the reverse proxy in front of the api (it listens on
  127.0.0.1 only).
- Check: `pbmb check` (`.env`, `book.yml`, the policy tests in `access/tests/`);
  `pbmb admin status` for the running deployment.
- Upgrade: change the image tag and its `@sha256:` digest in `compose.yml`
  together, read the release notes for changes to this directory, then
  `docker compose pull && docker compose up -d`. The api migrates at start.
- Settings are in Postgres: the admin section or `pbmb admin settings get|set`.
  `pbmb admin export -o book.yml` and `import book.yml` move them through git.
- Secrets are never in these files: a person runs
  `pbmb admin secrets set <name>`. Do not read, print or commit `.env`.
- Your Cerbos policies go in `access/policies/`, their tests in `access/tests/`.
<!-- powerbi-metrics-book:end -->
