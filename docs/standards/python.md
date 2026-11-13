# Python

Python code here reads like the rest of the code base: typed, plain, with
errors that say what to do next, and tests that would fail if the code were
wrong. This holds for `apps/cli` (distribution `powerbi-metrics-book`,
package `powerbi_metrics_book`, command `pbmb`) and every Python script in
the repository.

## Toolchain

- Python 3.13 through uv. The root `pyproject.toml` is the uv workspace;
  run every tool as `uv run <tool>` from the repository root.
- A dependency is pinned exactly in the `pyproject.toml` of the package
  that uses it, and `uv.lock` is committed in the same change. A version
  less than a day old waits, as pnpm makes it wait for TypeScript.
- `ruff==0.17.2` formats and lints, `mypy==2.4.0` checks types,
  `pytest==9.1.1` runs tests.

## Style

- `ruff format`, 88 characters.
- `ruff check` with pycodestyle, pyflakes, isort, bugbear, pyupgrade,
  pep8-naming, simplify and ruff's own rules. `ruff.toml` at the root holds
  the exact set.
- snake_case modules, functions and variables; PascalCase classes;
  UPPER_SNAKE_CASE constants. Full words in names (`naming.md`):
  `dataset`, never `ds`.
- `pathlib.Path` for paths.
- Comments explain why. No comment that narrates the next line, no runs of
  "Step 1", "Step 2". A docstring goes on a public interface where the
  convention asks for one (`Client.request` says what it raises), never on
  a three-line helper.
- No docstrings, comments or type hints added to code the change did not
  touch.
- No emoji in logs, CLI output or comments. They break on some terminals.
- Match the code base. Before writing a helper, search for one: a second
  credentials loader or retry wrapper next to the first is a defect.
- No abstraction without a second use: no interface with one
  implementation, no factory for one type, no layer that only passes calls
  through.

## Types

- `mypy --strict` passes on every package.
- Every function signature is typed.
- Values passed between modules are `@dataclass(frozen=True)`.
- `Protocol` when there are two implementations of our own. A test double
  counts as the second.
- `Literal` for a closed set of strings, matching the API's enum where one
  exists: `Literal["draft", "agent_verified", "human_verified"]`.
- `object` for a value you only pass along; `Any` only at an untyped
  library's edge.
- Never silence the checker. No `cast()` and no `# type: ignore` to make an
  error go away. A known typing bug in a library gets
  `# type: ignore[<code>]` with the reason and a link on the same line.

## Errors

- Handle an error where it can happen (I/O, parsing, the network, a child
  process, a person's input), with a decision for each.
- Raise a specific exception that names the file or thing and the problem:
  `ConventionsError("conventions.yml: naming.kinds[3] is 'avg'; a kind ends or starts with an underscore")`.
- Never swallow a failure: no bare `except:`, no `except Exception: pass`,
  no `contextlib.suppress(Exception)`.
- No fallback that hides a bug. `.get(key, {})` on a value whose absence
  means the input is broken turns a loud failure into a quiet wrong answer.
- No `try` around code that cannot raise, and no check for a case that
  cannot occur.
- The api is the authority on what is valid. The CLI sends what the person
  typed and shows the api's sentence; it keeps no second validator that
  can drift from the api's.
- In the CLI, an error a person can fix prints one sentence (what is wrong,
  and the command to run next) and exits non-zero. A bug shows its
  traceback.
- A secret value, an API key or a token never appears in an exception, a
  log line or any output.

```python
# Wrong: an expired login becomes an empty list, and the agent thinks there are no metrics.
try:
    metrics = client.get("/api/v1/metrics")["metrics"]
except ApiError:
    metrics = []

# Right: the ApiError reaches output.py, which prints the api's sentence
# ("Your login expired. Run pbmb login.") and exits with the code for its kind.
metrics = client.get("/api/v1/metrics")["metrics"]
```

## Processes, SQL and the network

- A child process gets an argv list, never `shell=True`.
- The CLI reads no database. Everything remote goes through
  `powerbi_metrics_book.client.Client` to `/api/v1`, which holds the base
  URL, the credentials and the error handling. The one other request it
  makes is downloading a CSV from the signed link the api returned.
- SQL, where a script needs it, takes parameters, never f-strings;
  semgrep refuses SQL built by formatting.

## CLI commands

- `powerbi_metrics_book.cli:app` is the Typer app behind `pbmb`. It
  registers every module in `powerbi_metrics_book/commands/`: a module that
  defines `app: typer.Typer` is a command group (`pbmb metrics list`); one
  that defines `command` is a single command (`pbmb whoami`).
- Every command takes `--json`. With it, the command prints exactly one
  JSON document to stdout and nothing else; keys are snake_case, as the
  API's.
- The help text is the CLI reference in the docs, so write it for a reader:
  what the command does, then each option.
- Credentials, secrets and the deployment directory: `apps/cli/AGENTS.md`.

## Tests

- pytest, in `apps/cli/tests/`, one `test_<module>.py` per module, in a
  folder per area of the package (`tests/commands/`). Security tests sit
  there too and are named `<subject>_security_test.py`.
- Fixtures go in `conftest.py`; helpers the tests share (classes, constants,
  functions) go in a module beside it named for its folder,
  `<area>_support.py`. Never `from conftest import`: once two folders have
  a `conftest.py`, that name means whichever pytest imported first.
- Test first for a change in behaviour: write the failing test, watch it
  fail for the reason you expect, then write the least code that passes.
- Each command's output and `--json` shape is tested against
  `httpx.MockTransport`, answering as the API's OpenAPI file says. The
  device flow and the commands together are tested against the real api in
  the end-to-end test. A double only for what cannot run here: the api in a
  unit test, or the clock (pass the date in).
- Assert behaviour. No `assert True`, and no assertion that only checks a
  mock returned what the test told it to.
- A skipped test is a failed test. No `pytest.mark.skip` to get to green.
- Never special-case code for a test, and never edit a test to match broken
  code. A wrong test is changed on purpose, with the reason in the commit.
- While working, run the one test file you are touching
  (`uv run pytest apps/cli/tests/test_cli.py -q`). The tiers are in the
  root `AGENTS.md`.

## Done

- Run the command that proves it works and read its output before saying
  it does.
- Done means every caller updated, no TODO stub, no placeholder
  implementation and no scope quietly narrowed. Say exactly what is left.
