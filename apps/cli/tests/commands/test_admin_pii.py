import json

import httpx
import pytest
from cli_support import Serve, json_response
from commands_support import run, sent


def test_mark_column_sends_rule_and_json_counts(serve: Serve) -> None:
    answer = {"rule": {"id": "rule_1"}, "columns": 2, "measures": 0, "datasets": 1}
    seen = serve(lambda request: json_response(200, answer))

    result = run("admin", "pii", "mark", "Customer[Email]", "--json")

    assert result.exit_code == 0
    assert sent(seen[0]) == {
        "kind": "column",
        "table": "Customer",
        "name": "Email",
        "pii": True,
    }
    assert json.loads(result.stdout) == answer


def test_global_json_prints_only_the_answer(serve: Serve) -> None:
    answer = {"rule": {"id": "rule_1"}, "columns": 0, "measures": 0, "datasets": 0}
    serve(lambda request: json_response(200, answer))

    result = run("--json", "admin", "pii", "mark", "Customer[Email]")

    assert result.exit_code == 0
    assert json.loads(result.stdout) == answer


def test_clear_json_has_zero_match_counts(serve: Serve) -> None:
    answer = {"rule": {"id": "rule_1"}, "columns": 0, "measures": 0, "datasets": 0}
    serve(lambda request: json_response(200, answer))

    result = run("admin", "pii", "clear", "Customer[Email]", "--json")

    assert result.exit_code == 0
    assert json.loads(result.stdout)["columns"] == 0


def test_mark_zero_match_prints_warning(serve: Serve) -> None:
    answer = {"rule": {"id": "rule_1"}, "columns": 0, "measures": 0, "datasets": 0}
    serve(lambda request: json_response(200, answer))

    result = run(
        "admin",
        "pii",
        "mark",
        "Customer",
        "--note",
        "Review",
    )

    assert result.exit_code == 0
    assert result.stdout.count("Matched") == 1
    assert "matches nothing yet" in result.stdout


def test_remove_finds_rule_id_then_deletes(serve: Serve) -> None:
    seen = serve(
        lambda request: (
            json_response(
                200,
                {
                    "rules": [
                        {
                            "id": "measure_1",
                            "version": "measure_version",
                            "kind": "measure",
                            "table_name": "Customer",
                            "name": "Email",
                        },
                        {
                            "id": "table_1",
                            "version": "table_version",
                            "kind": "table",
                            "table_name": "Customer",
                            "name": None,
                        },
                        {
                            "id": "rule_1",
                            "version": "column_version",
                            "kind": "column",
                            "table_name": "Customer",
                            "name": "Email",
                        },
                    ]
                },
            )
            if request.method == "GET"
            else httpx.Response(204)
        )
    )
    result = run("admin", "pii", "remove", "Customer[Email]", "--json")

    assert result.exit_code == 0
    assert [request.method for request in seen] == ["GET", "DELETE"]
    assert seen[1].url.path.endswith("/rule_1")
    assert dict(seen[1].url.params) == {"expected_version": "column_version"}
    assert json.loads(result.stdout) == {"id": "rule_1", "removed": True}


@pytest.mark.parametrize("options", [(), ("--json",)])
def test_remove_conflict_reports_api_message(
    serve: Serve, options: tuple[str, ...]
) -> None:
    message = "This PII rule changed. Reload it before trying again."
    serve(
        lambda request: (
            json_response(
                200,
                {
                    "rules": [
                        {
                            "id": "rule_1",
                            "version": "column_version",
                            "kind": "column",
                            "table_name": "Customer",
                            "name": "Email",
                        }
                    ]
                },
            )
            if request.method == "GET"
            else json_response(409, {"error": "conflict", "message": message})
        )
    )

    result = run("admin", "pii", "remove", "Customer[Email]", *options)

    assert result.exit_code == 1
    assert result.stderr == message + "\n"
    assert result.stdout == ""


def test_remove_missing_rule_does_not_delete(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"rules": []}))

    result = run("admin", "pii", "remove", "Customer[Email]")

    assert result.exit_code == 1
    assert "No PII rule matches" in result.stderr
    assert [request.method for request in seen] == ["GET"]


def test_bad_reference_exits_with_supported_forms_sentence(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "pii", "mark", "Customer[")

    assert result.exit_code == 1
    assert "Table[Column]" in result.stderr and "whole table" in result.stderr
    assert seen == []


def test_mark_measure_sends_measure_kind(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(
            200, {"rule": {}, "columns": 0, "measures": 1, "datasets": 1}
        )
    )

    result = run("admin", "pii", "mark", "Customer[Email Count]", "--measure", "--json")

    assert result.exit_code == 0
    assert sent(seen[0]) == {
        "kind": "measure",
        "table": "Customer",
        "name": "Email Count",
        "pii": True,
    }


def test_pii_list_filters_marked_and_cleared_rules(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"rules": []}))

    assert run("admin", "pii", "list", "--pii", "--json").exit_code == 0
    assert run("admin", "pii", "list", "--cleared", "--json").exit_code == 0
    assert [dict(request.url.params) for request in seen] == [
        {"pii": "true"},
        {"pii": "false"},
    ]


def test_suggest_filters_by_dataset_and_returns_json(serve: Serve) -> None:
    answer = {"suggestions": []}
    seen = serve(lambda request: json_response(200, answer))

    result = run("admin", "pii", "suggest", "--dataset", "Sales", "--json")

    assert result.exit_code == 0
    assert dict(seen[0].url.params) == {"dataset": "Sales"}
    assert json.loads(result.stdout) == answer
