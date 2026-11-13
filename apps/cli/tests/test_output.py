import json

import httpx
import pytest
from cli_support import URL, Serve, a_login, api_error, json_response
from typer.testing import CliRunner, Result

from powerbi_metrics_book import credentials
from powerbi_metrics_book.cli import app

ME = {
    "kind": "person",
    "id": "user-1",
    "email": "someone@sample-data.test",
    "roles": ["reader"],
}


def run(*arguments: str) -> Result:
    return CliRunner().invoke(app, list(arguments))


@pytest.fixture
def signed_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")
    monkeypatch.setenv("PBMB_URL", URL)


@pytest.mark.usefixtures("signed_in")
@pytest.mark.parametrize("arguments", [["--json", "whoami"], ["whoami", "--json"]])
def test_json_prints_exactly_one_document_on_stdout_and_nothing_else(
    serve: Serve, arguments: list[str]
) -> None:
    serve(lambda request: json_response(200, ME))

    result = run(*arguments)

    assert result.exit_code == 0
    assert json.loads(result.stdout) == ME
    assert result.stdout == json.dumps(ME, indent=2) + "\n"
    assert result.stderr == ""


@pytest.mark.usefixtures("signed_in")
@pytest.mark.parametrize(
    ("status", "kind", "code"),
    [
        (401, "unauthenticated", 3),
        (403, "refused", 4),
        (404, "not_found", 4),
        (429, "rate_limited", 5),
        (400, "invalid", 1),
        (409, "conflict", 1),
        (409, "needs_connection", 1),
        (502, "upstream", 1),
    ],
)
def test_each_error_kind_ends_with_its_exit_code_and_one_sentence_on_stderr(
    serve: Serve, status: int, kind: str, code: int
) -> None:
    serve(lambda request: api_error(status, kind, "That did not work."))

    result = run("whoami", "--json")

    assert result.exit_code == code
    assert result.stdout == ""
    assert result.stderr == "That did not work.\n"


@pytest.mark.usefixtures("signed_in")
def test_a_deployment_that_cannot_be_reached_exits_1(serve: Serve) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    serve(refuse)

    result = run("whoami")

    assert result.exit_code == 1
    assert result.stderr == f"Cannot reach {URL}: Connection refused.\n"


def test_not_being_signed_in_exits_3_and_says_how_to() -> None:
    result = run("--url", URL, "whoami")

    assert result.exit_code == 3
    assert result.stdout == ""
    assert "pbmb login" in result.stderr


def test_a_login_file_other_users_can_read_exits_1_with_the_fix() -> None:
    credentials.save(a_login())
    credentials.credentials_path().chmod(0o644)

    result = run("whoami")

    assert result.exit_code == 1
    assert "chmod 600" in result.stderr


def test_a_usage_error_exits_2() -> None:
    result = run("whoami", "--nonsense")

    assert result.exit_code == 2
    assert result.stdout == ""
