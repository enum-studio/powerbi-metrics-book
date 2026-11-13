"""pbmb agents eval: measure what the official skills change for an agent.

Each task in stack/agent_evals/<name>/ is run by a headless agent against a
fresh dev stack on the mock tenant, graded by the task's own check.py, and
recorded in docs/decisions/skills.md. Evals call a model, so they run only
when someone asks.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import Annotated

import httpx
import typer

from powerbi_metrics_book import credentials
from powerbi_metrics_book.credentials import CLIENT_ID, Login
from powerbi_metrics_book.output import JsonOption, Settings

app = typer.Typer(help="Measure what the official skills change for an agent.")

EVALS = Path("stack") / "agent_evals"
RESULTS = Path("docs") / "decisions" / "skills.md"
# The sample tenant's admin: Admin on every workspace, so every task can run.
SIGN_IN_AS = {
    "email": "admin@sample.example",
    "object_id": "a0000000-0000-4000-8000-000000000001",
}
AUTH_VARIABLES = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
}
NO_MCP_SERVERS = '{"mcpServers": {}}'
API_LOG_LINES = 50
AGENT_MINUTES = 30
SCRIPT_MINUTES = 10
STACK_MINUTES = 20
CLAUDE_BUDGET_USD = "5"
# The task files say what a person would ask; this says where the book is, as
# a person who gave the agent a terminal would. It is the same with and
# without the skill, so the skill is the only difference.
SURROUNDINGS = (
    "The company's Power BI Metrics Book is at {url}. The `pbmb` command is "
    "installed and signed in to it. Work in the current directory.\n\n"
)
TABLE_HEAD = (
    "| Date | Agent | Skill | Runs | Passed | Pass rate | Tokens per run "
    "| Cost per run | Why runs failed |\n"
    "|---|---|---|---|---|---|---|---|---|"
)


class Agent(StrEnum):
    claude = "claude"
    codex = "codex"


@dataclass(frozen=True)
class Task:
    name: str
    prompt: str
    setup: Path | None
    check: Path


@dataclass(frozen=True)
class Run:
    passed: bool
    reason: str
    tokens: int
    cost_usd: float | None
    seconds: float
    kept: Path | None = None


def repo_root() -> Path:
    """The checkout holding stack/agent_evals: PBMB_REPO, else the nearest parent."""
    named = os.environ.get("PBMB_REPO")
    candidates = [Path(named)] if named else [Path.cwd(), *Path.cwd().parents]
    for candidate in candidates:
        if (candidate / EVALS).is_dir():
            return candidate
    raise typer.BadParameter(
        "Run this inside the powerbi-metrics-book checkout, or set PBMB_REPO."
    )


def load_task(root: Path, name: str) -> Task:
    folder = root / EVALS / name
    if not (folder / "task.md").is_file() or not (folder / "check.py").is_file():
        known = sorted(found.parent.name for found in (root / EVALS).glob("*/task.md"))
        raise typer.BadParameter(f"No task {name}. The tasks are: {', '.join(known)}.")
    setup = folder / "setup.py"
    return Task(
        name=name,
        prompt=(folder / "task.md").read_text().strip(),
        setup=setup if setup.is_file() else None,
        check=folder / "check.py",
    )


def _stack(root: Path, *command: str) -> str:
    result = subprocess.run(
        command,
        cwd=root,
        capture_output=True,
        text=True,
        timeout=STACK_MINUTES * 60,
        check=False,
    )
    if result.returncode != 0:
        tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-15:])
        raise typer.BadParameter(f"{' '.join(command)} failed:\n{tail}")
    return result.stdout


def start_stack(root: Path) -> str:
    """A dev stack with nothing left from an earlier run; its address."""
    _stack(root, "pnpm", "dev:reset")
    _stack(root, "pnpm", "dev:up")
    return _stack(root, "node", "scripts/dev-stack.mjs", "url").strip()


def stop_stack(root: Path) -> None:
    _stack(root, "pnpm", "dev:down")


def answered(response: httpx.Response) -> None:
    """Stops with the api's own words when it answered with an error."""
    if response.is_error:
        raise typer.BadParameter(
            f"{response.request.method} {response.request.url.path} answered "
            f"{response.status_code}: {response.text[:500]}"
        )


def api_logs(root: Path) -> str:
    """The last lines of the api's log, for an error that has no other cause to show."""
    try:
        logs = _stack(root, "pnpm", "dev:logs", "api")
    except typer.BadParameter as error:
        return f"(the api's log could not be read: {error.message})"
    return "\n".join(logs.splitlines()[-API_LOG_LINES:])


def sign_in(url: str, config_home: Path, person: dict[str, str] = SIGN_IN_AS) -> None:
    """Saves a CLI login for person under config_home, as `pbmb login` would.

    The dev sign-in gives a browser session; the device code is allowed in it,
    which is what a person does at the page `pbmb login` shows.
    """
    with httpx.Client(base_url=url, timeout=30) as http:
        browser = http.post(
            "/api/auth/dev/sign-in", json=person, headers={"origin": url}
        )
        answered(browser)
        # A cookie jar withholds Secure cookies over http; a browser does not here.
        cookie = "; ".join(
            line.split(";")[0] for line in browser.headers.get_list("set-cookie")
        )
        discovery = http.get("/.well-known/oauth-authorization-server").json()
        device = http.post(
            discovery["device_authorization_endpoint"],
            data={
                "client_id": CLIENT_ID,
                "scope": "api offline_access",
                "resource": f"{url}/api/v1",
            },
        )
        answered(device)
        started = device.json()
        allowed = http.post(
            "/api/v1/oauth/device",
            json={"user_code": started["user_code"], "allow": True},
            headers={"origin": url, "cookie": cookie},
        )
        answered(allowed)
        token = http.post(
            discovery["token_endpoint"],
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": started["device_code"],
                "client_id": CLIENT_ID,
            },
        )
        answered(token)
        tokens = token.json()
    login = Login(
        url=url,
        client_id=CLIENT_ID,
        token_endpoint=discovery["token_endpoint"],
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        expires_at=datetime.now(UTC) + timedelta(seconds=tokens["expires_in"]),
    )
    previous = os.environ.get("XDG_CONFIG_HOME")
    os.environ["XDG_CONFIG_HOME"] = str(config_home)
    try:
        credentials.save(login)
    finally:
        if previous is None:
            del os.environ["XDG_CONFIG_HOME"]
        else:
            os.environ["XDG_CONFIG_HOME"] = previous


def clean_environment(parent: Mapping[str, str]) -> dict[str, str]:
    """parent without the Claude Code session's own variables.

    A run started from inside a Claude Code session would otherwise inherit its
    model overrides, session ids and flags, which change the agent under test.
    `claude -p` signs in from the stored login, so none is needed; what is kept
    is only what an API-key or token login, or a login kept elsewhere, reads.
    """
    return {
        name: value
        for name, value in parent.items()
        if not name.startswith(("CLAUDE", "ANTHROPIC")) or name in AUTH_VARIABLES
    }


def environment(url: str, config_home: Path, workdir: Path) -> dict[str, str]:
    """What the agent, setup and check all see: a signed-in `pbmb` and the folder."""
    bin_dir = str(Path(sys.executable).parent)
    return {
        **clean_environment(os.environ),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
        "PBMB_URL": url,
        "XDG_CONFIG_HOME": str(config_home),
        "PBMB_EVAL_WORKDIR": str(workdir),
        "PBMB_EVAL_STATE": str(workdir.parent / "state.json"),
    }


def agent_command(
    agent: Agent, prompt: str, root: Path, workdir: Path, with_skill: bool
) -> list[str]:
    """The headless command. Codex finds its skills in workdir/.agents, which
    one_run copies there for a run with the skill."""
    if agent is Agent.claude:
        command = [
            "claude",
            "-p",
            prompt,
            "--output-format",
            "json",
            "--permission-mode",
            "bypassPermissions",
            # Only the working folder's settings: the person's own skills,
            # hooks and memory would reach both arms and blur the difference.
            "--setting-sources",
            "project",
            "--no-session-persistence",
            "--max-budget-usd",
            CLAUDE_BUDGET_USD,
            # The person's own MCP servers can reach company data. The tasks go
            # through the `pbmb` command, so no server is the isolation.
            "--strict-mcp-config",
            "--mcp-config",
            NO_MCP_SERVERS,
        ]
        # Off means no skill at all, not only ours.
        command += (
            ["--plugin-dir", str(root)] if with_skill else ["--disable-slash-commands"]
        )
        return command
    return [
        "codex",
        "exec",
        # No $CODEX_HOME/config.toml, where the person's MCP servers are set.
        # A project .codex/config.toml would still load; the folder it works
        # in is empty.
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        str(workdir),
        prompt,
    ]


def read_usage(agent: Agent, output: str) -> tuple[int, float | None]:
    """Tokens of every kind, and the cost when the agent reports one.

    Raises ValueError when the agent printed no usage, so a run is never
    recorded with tokens it did not count.
    """
    if agent is Agent.claude:
        try:
            answer = json.loads(output)
            usage = answer["usage"]
        except (KeyError, TypeError) as error:
            raise ValueError("claude's answer holds no usage") from error
        tokens = sum(
            int(usage.get(key) or 0)
            for key in (
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )
        return tokens, answer.get("total_cost_usd")
    turns = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "turn.completed":
            turns.append(event.get("usage") or {})
    if not turns:
        raise ValueError("codex printed no turn.completed event")
    tokens = sum(
        int(turn.get("input_tokens") or 0) + int(turn.get("output_tokens") or 0)
        for turn in turns
    )
    return tokens, None


def _script(path: Path, env: dict[str, str], workdir: Path) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            [sys.executable, str(path)],
            cwd=workdir,
            env=env,
            capture_output=True,
            text=True,
            timeout=SCRIPT_MINUTES * 60,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, f"{path.name} ran longer than {SCRIPT_MINUTES} minutes"
    said = " ".join((result.stdout + " " + result.stderr).split())
    return result.returncode == 0, said


def csv_heads(workdir: Path, lines: int = 5) -> str:
    """The first lines of each CSV the run left, on one line, for the reason."""
    heads = []
    for path in sorted(workdir.rglob("*.csv")):
        head = path.read_text(errors="replace").splitlines()[:lines]
        heads.append(f"{path.name}: " + " / ".join(head))
    return "; ".join(heads)


def keep(workdir: Path, output: str, stderr: str) -> Path:
    """Copies the run's files and the agent's own output to the system temp folder.

    The sign-in beside the work folder holds a token for the throwaway stack
    and is left behind.
    """
    kept = Path(tempfile.mkdtemp(prefix="pbmb-eval-kept-"))
    shutil.copytree(workdir, kept / "work")
    (kept / "agent_stdout.txt").write_text(output)
    (kept / "agent_stderr.txt").write_text(stderr)
    return kept


def one_run(root: Path, task: Task, agent: Agent, with_skill: bool) -> Run:
    url = start_stack(root)
    with tempfile.TemporaryDirectory(prefix="pbmb-eval-") as scratch:
        workdir = Path(scratch) / "work"
        workdir.mkdir()
        config_home = Path(scratch) / "config"
        try:
            sign_in(url, config_home)
        except typer.BadParameter as error:
            raise typer.BadParameter(
                f"The eval's sign-in failed: {error.message}\n"
                f"The api's last log lines:\n{api_logs(root)}"
            ) from error
        env = environment(url, config_home, workdir)
        if task.setup is not None:
            ready, said = _script(task.setup, env, workdir)
            if not ready:
                raise typer.BadParameter(
                    f"The setup of {task.name} failed: {said}\n"
                    f"The api's last log lines:\n{api_logs(root)}"
                )
        if agent is Agent.codex and with_skill:
            shutil.copytree(root / ".agents", workdir / ".agents")
        command = agent_command(
            agent, SURROUNDINGS.format(url=url) + task.prompt, root, workdir, with_skill
        )
        started = time.monotonic()
        try:
            finished = subprocess.run(
                command,
                cwd=workdir,
                env=env,
                capture_output=True,
                text=True,
                timeout=AGENT_MINUTES * 60,
                check=False,
            )
            output, crashed = finished.stdout, finished.returncode != 0
            stderr = finished.stderr
        except subprocess.TimeoutExpired as error:
            output = (
                error.stdout.decode()
                if isinstance(error.stdout, bytes)
                else (error.stdout or "")
            )
            crashed, stderr = True, f"{agent} ran longer than {AGENT_MINUTES} minutes"
        seconds = time.monotonic() - started
        passed, said = _script(task.check, env, workdir)
        heads = csv_heads(workdir)
        kept = keep(workdir, output, stderr)
    try:
        tokens, cost = read_usage(agent, output)
    except ValueError as error:
        # Without its usage the run cannot be compared, whatever the check said.
        tokens, cost, passed = 0, None, False
        said = f"{agent} printed no readable usage ({error!r}); the check said: {said}"
    if passed:
        return Run(True, "", tokens, cost, seconds, kept)
    reason = said or "the check failed and said nothing"
    if heads:
        reason = f"{reason} [first lines: {heads}]"
    if crashed:
        said_by_agent = " ".join(stderr.split())[:200]
        reason = f"{agent} stopped with an error ({said_by_agent}); {reason}"
    return Run(False, reason, tokens, cost, seconds, kept)


def table_row(day: date, agent: Agent, with_skill: bool, runs: list[Run]) -> str:
    passed = sum(1 for each in runs if each.passed)
    tokens = sum(each.tokens for each in runs) // len(runs)
    costs = [each.cost_usd for each in runs if each.cost_usd is not None]
    cost = f"${sum(costs) / len(costs):.2f}" if costs else "not reported"
    failures = "; ".join(
        sorted({each.reason[:1200] for each in runs if not each.passed})
    ).replace("|", "/")
    return (
        f"| {day.isoformat()} | {agent} | {'on' if with_skill else 'off'} | "
        f"{len(runs)} | {passed} | {round(100 * passed / len(runs))}% | "
        f"{tokens:,} | {cost} | {failures or 'none'} |"
    )


def record(path: Path, task: str, row: str) -> None:
    """Puts row in the task's table, replacing a row of the same date, agent, skill."""
    text = path.read_text() if path.exists() else "# Skills\n"
    heading = f"## {task}"
    key = row.split("|")[1:4]
    if heading not in text:
        text = f"{text.rstrip()}\n\n{heading}\n\n{TABLE_HEAD}\n{row}\n"
        path.write_text(text)
        return
    lines = text.splitlines()
    start = lines.index(heading)
    end = next(
        (at for at in range(start + 1, len(lines)) if lines[at].startswith("## ")),
        len(lines),
    )
    section = [
        line
        for line in lines[start:end]
        if not (line.startswith("|") and line.split("|")[1:4] == key)
    ]
    while section and section[-1] == "":
        section.pop()
    lines[start:end] = [*section, row, *([""] if end < len(lines) else [])]
    path.write_text("\n".join(lines) + "\n")


def eval_document(
    task: str, agent: Agent, with_skill: bool, runs: list[Run]
) -> dict[str, object]:
    return {
        "task": task,
        "agent": str(agent),
        "skill": with_skill,
        "pass_rate": sum(1 for each in runs if each.passed) / len(runs),
        "runs": [
            {
                "passed": each.passed,
                "reason": each.reason,
                "tokens": each.tokens,
                "cost_usd": each.cost_usd,
                "kept": str(each.kept) if each.kept else None,
            }
            for each in runs
        ],
    }


@app.command("eval")
def run_eval(
    context: typer.Context,
    task: Annotated[str, typer.Option(help="A folder name in stack/agent_evals.")],
    runs: Annotated[int, typer.Option(min=1, help="How many times to run it.")] = 3,
    agent: Annotated[Agent, typer.Option(help="claude or codex.")] = Agent.claude,
    without_skill: Annotated[
        bool, typer.Option("--without-skill", help="Run with the skills turned off.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Run a task headless against a fresh dev stack and record how it went.

    Each run resets and starts the dev stack (pnpm dev:reset, pnpm dev:up;
    Node 24 first on PATH), runs the task's setup, lets the agent do the task
    in an empty folder, then runs the task's check. The pass rate, tokens and
    cost per run go into docs/decisions/skills.md. With --json the answer is
    one document holding every run. This calls a model for each run and costs
    money.

    Example: pbmb agents eval --task csv_sales_by_month --runs 3 --without-skill
    """
    root = repo_root()
    chosen = load_task(root, task)
    with_skill = not without_skill
    skill = "on" if with_skill else "off"
    results: list[Run] = []
    try:
        for number in range(1, runs + 1):
            typer.echo(
                f"Run {number} of {runs}: {task}, {agent}, skill {skill}", err=True
            )
            result = one_run(root, chosen, agent, with_skill)
            outcome = "passed" if result.passed else f"failed: {result.reason}"
            typer.echo(f"  {outcome}", err=True)
            typer.echo(f"  files and agent output kept in {result.kept}", err=True)
            results.append(result)
    finally:
        stop_stack(root)
    row = table_row(date.today(), agent, with_skill, results)
    record(root / RESULTS, task, row)
    if json_output or context.ensure_object(Settings).as_json:
        typer.echo(
            json.dumps(eval_document(task, agent, with_skill, results), indent=2)
        )
    else:
        typer.echo(row)
