import json
from datetime import UTC, datetime

from cli_support import Serve, json_response
from commands_support import run

REPORT = {
    "totals": {"requests": 1},
    "hidden": 0,
    "not_covered": {"searches_with_no_hits": [{"query": "a|b\nnext", "count": 2}]},
    "badly_structured": {"failed_queries": []},
    "truncated_lists": ["searches_with_no_hits"],
}


def test_report_tables_and_relative_since(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, REPORT))
    result = run(
        "usage", "report", "--since", "30d", "--dataset", "Sales", "--limit", "3"
    )
    assert result.exit_code == 0, result.stderr
    assert seen[0].url.path == "/api/v1/usage/report"
    since = datetime.fromisoformat(seen[0].url.params["since"])
    assert 29 < (datetime.now(UTC) - since).total_seconds() / 86400 < 31
    assert seen[0].url.params["dataset"] == "Sales"
    assert seen[0].url.params["limit"] == "3"
    assert "searches_with_no_hits (truncated)" in result.stdout
    assert "| query | count |" in result.stdout
    assert "a\\|b next" in result.stdout
    assert "failed_queries" in result.stdout


def test_report_json_and_iso_times(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, REPORT))
    result = run(
        "usage",
        "report",
        "--since",
        "2026-11-01T00:00:00Z",
        "--until",
        "2026-11-11T00:00:00Z",
        "--json",
    )
    assert result.exit_code == 0, result.stderr
    assert json.loads(result.stdout) == REPORT
    assert seen[0].url.params["since"] == "2026-11-01T00:00:00Z"
    assert seen[0].url.params["until"] == "2026-11-11T00:00:00Z"
