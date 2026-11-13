import json
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import httpx
import pytest
import typer
from commands_support import run

from powerbi_metrics_book.commands import agents
from powerbi_metrics_book.commands.agents import Agent, Run

REPOSITORY = Path(__file__).resolve().parents[4]
URL = "http://localhost:30000"

# A claude that logs how it was called, does the demo task when asked to, and
# answers the way `claude -p --output-format json` does.
FAKE_CLAUDE = f"""#!{sys.executable}
import json, os, sys
from pathlib import Path

with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("FAKE_DOES_TASK"):
    Path("done.txt").write_text("done")
if os.environ.get("FAKE_WRITES_CSV"):
    Path("sales.csv").write_text("".join(f"line {{n}}\\n" for n in range(8)))
if os.environ.get("FAKE_PRINTS_JUNK"):
    print("not json")
    sys.exit(1)
print(json.dumps({{
    "is_error": False,
    "total_cost_usd": 0.25,
    "usage": {{
        "input_tokens": 100, "output_tokens": 20,
        "cache_creation_input_tokens": 30, "cache_read_input_tokens": 50,
    }},
}}))
"""

# A codex that logs its arguments and whether the skills folder was in its folder.
FAKE_CODEX = f"""#!{sys.executable}
import json, os, sys
from pathlib import Path

with open(Path(os.environ["FAKE_LOG"]).with_name("codex_calls.jsonl"), "a") as log:
    log.write(json.dumps({{
        "argv": sys.argv[1:], "skills": Path(".agents/skills").is_dir(),
    }}) + "\\n")
print(json.dumps({{
    "type": "turn.completed", "usage": {{"input_tokens": 3, "output_tokens": 4}},
}}))
"""

DEMO_CHECK = """import os, sys
from pathlib import Path

work = Path(os.environ["PBMB_EVAL_WORKDIR"])
if not (work / "started.txt").exists():
    sys.exit("the setup did not run")
if not (work / "done.txt").exists():
    sys.exit("done.txt was not written")
"""
DEMO_SETUP = """import os
from pathlib import Path

(Path(os.environ["PBMB_EVAL_WORKDIR"]) / "started.txt").write_text("")
"""


@pytest.fixture(autouse=True)
def private_tempdir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The kept run folders and scratch folders go under tmp_path, not TMPDIR."""
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))


@pytest.fixture
def stack_calls() -> list[str]:
    return []


@pytest.fixture
def evals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stack_calls: list[str]
) -> Path:
    """A checkout with two tasks, a fake claude first on PATH and no Docker."""
    root = tmp_path / "checkout"
    tasks = root / "stack" / "agent_evals"
    shutil.copytree(
        REPOSITORY / "stack" / "agent_evals" / "csv_sales_by_month",
        tasks / "csv_sales_by_month",
    )
    # The CSV task's setup needs a live stack, where it is proved; these tests
    # use the task for its check and its prompt.
    (tasks / "csv_sales_by_month" / "setup.py").unlink()
    shutil.copy(REPOSITORY / "stack" / "agent_evals" / "support.py", tasks)
    demo = tasks / "demo"
    demo.mkdir()
    (demo / "task.md").write_text("Write done.txt.\n")
    (demo / "check.py").write_text(DEMO_CHECK)
    (demo / "setup.py").write_text(DEMO_SETUP)
    (root / "docs" / "decisions").mkdir(parents=True)
    (root / "docs" / "decisions" / "skills.md").write_text("# Skills\n")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "claude_calls.jsonl"))

    def start(_root: Path) -> str:
        stack_calls.append("up")
        return URL

    monkeypatch.setattr(agents, "repo_root", lambda: root)
    monkeypatch.setattr(agents, "start_stack", start)
    monkeypatch.setattr(agents, "stop_stack", lambda _root: stack_calls.append("down"))
    monkeypatch.setattr(agents, "sign_in", lambda _url, _config_home: None)
    monkeypatch.setattr(agents, "api_logs", lambda _root: "the api's log lines")
    return root


def results(root: Path) -> str:
    return (root / "docs" / "decisions" / "skills.md").read_text()


def calls(tmp_path: Path) -> list[list[str]]:
    lines = (tmp_path / "claude_calls.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines]


def test_a_fake_agent_that_writes_no_csv_fails_the_csv_task_with_the_checks_reason(
    evals: Path,
) -> None:
    result = run("agents", "eval", "--task", "csv_sales_by_month", "--runs", "1")

    assert result.exit_code == 0, result.output
    table = results(evals).split("## csv_sales_by_month")[1]
    assert "| claude | on | 1 | 0 | 0% |" in table
    assert "no CSV file" in table


def test_a_fake_agent_that_does_the_task_passes_and_the_table_holds_tokens_and_cost(
    evals: Path, stack_calls: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_DOES_TASK", "1")

    result = run("agents", "eval", "--task", "demo", "--runs", "2")

    assert result.exit_code == 0, result.output
    today = date.today().isoformat()
    row = f"| {today} | claude | on | 2 | 2 | 100% | 200 | $0.25 | none |"
    assert row in results(evals)
    assert stack_calls == ["up", "up", "down"]


def test_json_prints_one_document_with_each_run_and_still_records_the_row(
    evals: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_DOES_TASK", "1")

    result = run("agents", "eval", "--task", "demo", "--runs", "2", "--json")

    assert result.exit_code == 0, result.output
    document = json.loads(result.stdout)
    assert document["task"] == "demo"
    assert document["agent"] == "claude"
    assert document["skill"] is True
    assert document["pass_rate"] == 1.0
    runs = document["runs"]
    assert [(r["passed"], r["tokens"], r["cost_usd"]) for r in runs] == [
        (True, 200, 0.25),
        (True, 200, 0.25),
    ]
    assert all(each["kept"] for each in runs)
    assert "| claude | on | 2 | 2 | 100% |" in results(evals)


def test_an_agent_that_prints_no_usage_fails_the_run_even_when_the_check_passes(
    evals: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_DOES_TASK", "1")
    monkeypatch.setenv("FAKE_PRINTS_JUNK", "1")

    result = run("agents", "eval", "--task", "demo", "--runs", "1")

    assert result.exit_code == 0, result.output
    table = results(evals)
    assert "| claude | on | 1 | 0 | 0% | 0 | not reported |" in table
    assert "printed no readable usage" in table


def test_the_skill_is_off_for_without_skill_and_on_otherwise(
    evals: Path, tmp_path: Path
) -> None:
    run("agents", "eval", "--task", "demo", "--runs", "1")
    run("agents", "eval", "--task", "demo", "--runs", "1", "--without-skill")

    skilled, bare = calls(tmp_path)
    assert skilled[skilled.index("--plugin-dir") + 1] == str(evals)
    assert "--disable-slash-commands" not in skilled
    assert "--plugin-dir" not in bare
    assert "--disable-slash-commands" in bare
    assert "| claude | off | 1 | 0 | 0% |" in results(evals)
    assert "| claude | on | 1 | 0 | 0% |" in results(evals)


def test_the_agent_gets_the_task_after_where_the_book_is(
    evals: Path, tmp_path: Path
) -> None:
    run("agents", "eval", "--task", "demo", "--runs", "1")

    prompt = calls(tmp_path)[0][1]
    assert prompt.startswith("The company's Power BI Metrics Book is at " + URL)
    assert prompt.endswith("Write done.txt.")


def test_a_failed_setup_stops_the_run_and_still_takes_the_stack_down(
    evals: Path, stack_calls: list[str]
) -> None:
    (evals / "stack" / "agent_evals" / "demo" / "setup.py").write_text(
        "raise SystemExit('no sample tenant')"
    )

    result = run("agents", "eval", "--task", "demo", "--runs", "1")

    assert result.exit_code != 0
    assert "no sample tenant" in result.output
    assert stack_calls == ["up", "down"]
    assert "demo" not in results(evals)


def test_an_unknown_task_names_the_known_ones(evals: Path) -> None:
    result = run("agents", "eval", "--task", "nonesuch")

    assert result.exit_code == 2
    assert "csv_sales_by_month" in result.output
    assert "demo" in result.output


def test_a_row_holds_the_pass_rate_mean_tokens_and_cost_and_escapes_pipes() -> None:
    day = date(2026, 10, 27)
    passed = Run(True, "", 100, 0.5, 1.0)
    failed = Run(False, "no CSV | at all", 300, 1.5, 1.0)

    row = agents.table_row(day, Agent.claude, True, [passed, failed])

    assert row == (
        "| 2026-10-27 | claude | on | 2 | 1 | 50% | 200 | $1.00 | no CSV / at all |"
    )


def test_record_replaces_the_row_of_the_same_configuration_and_keeps_the_rest(
    tmp_path: Path,
) -> None:
    path = tmp_path / "skills.md"
    path.write_text("# Skills\n")
    on = "| 2026-10-27 | claude | on | 1 | 1 | 100% | 10 | $0.10 | none |"
    off = "| 2026-10-27 | claude | off | 1 | 0 | 0% | 10 | $0.10 | x |"
    again = "| 2026-10-27 | claude | on | 1 | 0 | 0% | 20 | $0.20 | y |"

    agents.record(path, "first", on)
    agents.record(path, "second", off)
    agents.record(path, "first", off)
    agents.record(path, "first", again)

    first, second = path.read_text().split("## second")
    assert again in first
    assert on not in first
    assert off in first
    assert off in second


def test_codex_tokens_are_summed_over_its_turns_and_it_reports_no_cost() -> None:
    output = "\n".join(
        [
            "not json",
            json.dumps({"type": "turn.started"}),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                }
            ),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {"input_tokens": 20, "output_tokens": 1},
                }
            ),
        ]
    )

    assert agents.read_usage(Agent.codex, output) == (36, None)


def test_codex_gets_the_skills_folder_only_with_the_skill_and_no_user_config(
    evals: Path, tmp_path: Path
) -> None:
    (evals / ".agents" / "skills").mkdir(parents=True)
    fake = tmp_path / "bin" / "codex"
    fake.write_text(FAKE_CODEX)
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

    run("agents", "eval", "--task", "demo", "--runs", "1", "--agent", "codex")
    run(
        *("agents", "eval", "--task", "demo", "--runs", "1", "--agent", "codex"),
        "--without-skill",
    )

    skilled, bare = [
        json.loads(line)
        for line in (tmp_path / "codex_calls.jsonl").read_text().splitlines()
    ]
    assert skilled["skills"] is True
    assert bare["skills"] is False
    assert "--ignore-user-config" in skilled["argv"]


def test_the_claude_command_loads_no_mcp_server_but_the_ones_it_is_given(
    evals: Path, tmp_path: Path
) -> None:
    run("agents", "eval", "--task", "demo", "--runs", "1")
    run("agents", "eval", "--task", "demo", "--runs", "1", "--without-skill")

    for command in calls(tmp_path):
        assert "--strict-mcp-config" in command
        assert command.count("--mcp-config") == 1
        configured = json.loads(command[command.index("--mcp-config") + 1])
        assert configured == {"mcpServers": {}}


def test_a_failed_run_names_the_first_lines_of_each_csv_and_keeps_its_files(
    evals: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_WRITES_CSV", "1")

    result = run("agents", "eval", "--task", "demo", "--runs", "1")

    table = results(evals)
    assert "done.txt was not written" in table
    assert "sales.csv: line 0 / line 1 / line 2 / line 3 / line 4" in table
    assert "line 5" not in table
    kept = Path(result.output.split("kept in ")[1].split()[0])
    assert (kept / "work" / "sales.csv").read_text().startswith("line 0")
    assert (kept / "agent_stdout.txt").read_text().startswith("{")


# A pbmb that answers the two calls the CSV check makes, and logs how it was called.
FAKE_PBMB = f"""#!{sys.executable}
import json, os, sys

with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if "queries" in sys.argv:
    sales = {{
        "dataset": {{"name": "Sales"}},
        "measure_names": ["Net sales"],
        "metric_ids": ["m1"],
    }}
    # The first entry is a refused query, which has no dataset. The analyst's
    # query is everyone's to see; the agent's own is there when it ran one.
    items = [
        {{"dataset": None, "measure_names": [], "metric_ids": [], "mine": True}},
        {{**sales, "mine": False}},
    ]
    if os.environ.get("FAKE_OWN_QUERY") == "1":
        items.append({{**sales, "mine": True}})
    if "--mine" in sys.argv:
        items = [item for item in items if item["mine"]]
    print(json.dumps({{"items": items}}))
else:
    months = json.loads(os.environ["FAKE_MONTHS"])
    rows = [[f"2025-{{n + 1:02d}}", v] for n, v in enumerate(months)]
    print(json.dumps({{"preview": rows}}))
"""
MONTHS = [round(14000 + 137.37 * n, 2) for n in range(12)]


def run_csv_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    csv: str,
    own_query: bool = True,
) -> tuple[int, str]:
    """Runs the CSV task's check on a folder holding csv, against the fake pbmb."""
    work = tmp_path / "work"
    work.mkdir()
    (work / "sales.csv").write_text(csv)
    bin_dir = tmp_path / "pbmb_bin"
    bin_dir.mkdir()
    fake = bin_dir / "pbmb"
    fake.write_text(FAKE_PBMB)
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "pbmb_calls.jsonl"))
    monkeypatch.setenv("FAKE_MONTHS", json.dumps(MONTHS))
    monkeypatch.setenv("FAKE_OWN_QUERY", "1" if own_query else "0")
    monkeypatch.setenv("PBMB_EVAL_WORKDIR", str(work))
    monkeypatch.setenv("PBMB_EVAL_YEAR", "2026")
    check = REPOSITORY / "stack" / "agent_evals" / "csv_sales_by_month" / "check.py"
    done = subprocess.run(
        [sys.executable, str(check)], capture_output=True, text=True, check=False
    )
    return done.returncode, done.stdout


def as_csv(figures: list[float], total: float | None = None) -> str:
    rows = [f"2025-{n + 1:02d},{figure}" for n, figure in enumerate(figures)]
    return "\n".join(["month,net_sales", *rows, *([f"TOTAL,{total}"] if total else [])])


def test_the_csv_check_passes_a_csv_with_the_right_figure_for_each_month(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, said = run_csv_check(tmp_path, monkeypatch, as_csv(MONTHS))

    assert (code, said) == (0, "")
    searched = json.loads((tmp_path / "pbmb_calls.jsonl").read_text().splitlines()[0])
    assert searched[:3] == ["--json", "queries", "search"]
    assert "Net sales" in searched
    assert searched[searched.index("--dataset") + 1] == "Sales"
    assert "--mine" in searched


def test_the_csv_check_fails_when_only_a_colleagues_query_is_in_the_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, said = run_csv_check(tmp_path, monkeypatch, as_csv(MONTHS), own_query=False)

    assert code == 1
    assert "the query log has no successful" in said


def test_the_csv_check_fails_the_right_figures_in_the_wrong_month_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shuffled = [*MONTHS[6:], *MONTHS[:6]]

    code, said = run_csv_check(tmp_path, monkeypatch, as_csv(shuffled))

    assert code == 1
    assert "not in calendar month order" in said


def test_the_csv_check_accepts_one_total_row_in_any_case(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, said = run_csv_check(
        tmp_path, monkeypatch, as_csv(MONTHS, round(sum(MONTHS), 2))
    )

    assert (code, said) == (0, "")


def test_the_csv_check_refuses_a_total_row_that_is_not_the_sum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, said = run_csv_check(tmp_path, monkeypatch, as_csv(MONTHS, 1.0))

    assert code == 1
    assert "no numeric column holds the 12 monthly net sales" in said


def test_the_csv_check_fails_gross_amounts_and_names_the_difference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gross = [figure + 10 for figure in MONTHS]

    code, said = run_csv_check(tmp_path, monkeypatch, as_csv(gross))

    assert code == 1
    assert f"sales.csv has 12 rows summing to {sum(gross):.2f}, +120.00 from" in said
    assert f"{sum(MONTHS):.2f}" in said


def test_the_csv_check_fails_months_rounded_to_whole_units(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, said = run_csv_check(
        tmp_path, monkeypatch, as_csv([float(round(v)) for v in MONTHS])
    )

    assert code == 1
    assert "no numeric column holds" in said


def test_the_agent_gets_no_claude_session_variables_but_the_ones_auth_reads() -> None:
    parent = {
        "HOME": "/home/someone",
        "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet",
        "CLAUDECODE": "1",
        "CLAUDE_CODE_SESSION_ID": "abc",
        "ANTHROPIC_MODEL": "other",
        "ANTHROPIC_API_KEY": "key",
        "CLAUDE_CODE_OAUTH_TOKEN": "token",
        "CLAUDE_CONFIG_DIR": "/elsewhere",
    }

    assert agents.clean_environment(parent) == {
        "HOME": "/home/someone",
        "ANTHROPIC_API_KEY": "key",
        "CLAUDE_CODE_OAUTH_TOKEN": "token",
        "CLAUDE_CONFIG_DIR": "/elsewhere",
    }


def test_the_run_environment_starts_from_the_clean_one(
    evals: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CODE_SUBAGENT_MODEL", "sonnet")

    env = agents.environment(URL, evals / "config", evals / "work")

    assert "CLAUDE_CODE_SUBAGENT_MODEL" not in env
    assert env["PBMB_URL"] == URL


def test_a_failed_sign_in_names_the_response_and_the_apis_last_log_lines(
    evals: Path, stack_calls: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def refused(_url: str, _config_home: Path) -> None:
        raise typer.BadParameter("POST /api/auth/dev/sign-in answered 500: boom")

    monkeypatch.setattr(agents, "sign_in", refused)
    monkeypatch.setattr(agents, "api_logs", lambda _root: "api | the real cause")

    result = run("agents", "eval", "--task", "demo", "--runs", "1")

    assert result.exit_code != 0
    assert "answered 500: boom" in result.output
    assert "the real cause" in result.output
    assert stack_calls == ["up", "down"]


def test_an_error_answer_is_raised_with_its_status_and_body() -> None:
    response = httpx.Response(
        500,
        text="the body",
        request=httpx.Request("POST", "http://localhost/api/auth/dev/sign-in"),
    )

    with pytest.raises(typer.BadParameter, match="answered 500: the body"):
        agents.answered(response)
