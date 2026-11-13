# apps/cli

`pbmb`, the command line for the book and its deployment: Python 3.13
with Typer, package `powerbi_metrics_book`, published on PyPI as
`powerbi-metrics-book`. Every remote command goes through `/api/v1`;
nothing here reads the database. Local commands work on a deployment
directory (`pbmb init`, `pbmb check`).

Standards: `docs/standards/python.md`. Names: `docs/standards/naming.md`.

## Where things go

- `src/powerbi_metrics_book/cli.py`: the Typer app. It registers every
  module in `commands/`: a module defining `app: typer.Typer` becomes a
  command group (`pbmb metrics list`), one defining `command` a single
  command (`pbmb whoami`). A module defining neither, or both, fails at
  start-up.
- `src/powerbi_metrics_book/client.py`: `Client`, the one way to the api
  (base URL, credentials, the api's errors as `ApiError`).
- `src/powerbi_metrics_book/credentials.py`: the device-flow login in
  `~/.config/pbmb/credentials.json`, mode 0600.
- `src/powerbi_metrics_book/output.py`: `--json` and human output, errors
  as one sentence on stderr, the exit codes.
- `tests/`, one folder per area of the package.

## Rules here

- Every command takes `--json`. With it, the command prints exactly one
  JSON document to stdout and nothing else.
- The help text is the CLI reference in the docs: write it for a reader.
- Credentials in order: `PBMB_API_KEY`, then the saved login. `PBMB_URL`
  or `--url` names the deployment.
- `pbmb admin secrets set` prompts without echo, refuses a value on the
  command line and refuses to run without a terminal. No command prints a
  secret value, an API key after it is first shown, or a token.
- The CLI keeps no rule of its own: the api decides what is valid and who
  may do what, and the CLI shows the api's sentence. The one exception is
  `SECRET_NAME` in `commands/admin.py`, because a value typed where a name
  goes must never reach a URL. A test in `requests_security_test.py` fails
  when a secret the api knows is missing from it.
- Remote commands take their types from the API's OpenAPI file.
- The deployment directory's format (`compose.yml`, `.env`, `access/`,
  `book.yml`, `AGENTS.md`) is a public interface with `format: 1` and a
  JSON Schema per file. A change an existing deployment would fail is a
  major version, with a `pbmb upgrade` migration and its test.

The secrets and credentials code is a sensitive path: a change there gets
the security review in `docs/security/agents.md`, rule 3.

## Check

```bash
uv run pytest apps/cli/tests -q
uv run mypy
uv run ruff format --check apps/cli && uv run ruff check apps/cli
```
