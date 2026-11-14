import json

import pytest
from cli_support import Serve, api_error, json_response
from commands_support import run


@pytest.mark.parametrize("as_json", [False, True])
def test_thread_command_shows_questions_off(serve: Serve, as_json: bool) -> None:
    message = "Questions are off. An admin turns them on under Settings, General."
    serve(lambda request: api_error(404, "questions_off", message))

    result = run("questions", "list", *(["--json"] if as_json else []))

    assert result.exit_code == 1
    assert result.stderr.strip() == message
    assert result.stdout == ""


@pytest.mark.parametrize("command", ["metrics", "terms"])
def test_show_omits_absent_question_fields(serve: Serve, command: str) -> None:
    answer = {
        "name": "orders",
        "failing_checks": [],
        "terms": [],
        "base_variants": [],
        "other_variants": [],
        "metrics": [],
        "columns": [],
    }
    serve(lambda request: json_response(200, answer))

    result = run(command, "show", "orders")

    assert result.exit_code == 0
    assert "question" not in result.stdout.lower()
    assert "answered" not in result.stdout.lower()


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("as_json", [False, True])
def test_whoami_shows_questions(serve: Serve, enabled: bool, as_json: bool) -> None:
    answer = {"kind": "person", "questions": enabled}
    serve(lambda request: json_response(200, answer))

    result = run("whoami", *(["--json"] if as_json else []))

    assert result.exit_code == 0
    if as_json:
        assert json.loads(result.stdout) == answer
    else:
        assert f"Questions: {'on' if enabled else 'off'}" in result.stdout
