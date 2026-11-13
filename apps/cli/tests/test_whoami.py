import json

import pytest
from cli_support import URL, Serve, a_login, json_response
from typer.testing import CliRunner, Result

from powerbi_metrics_book import credentials
from powerbi_metrics_book.cli import app


def run(*arguments: str) -> Result:
    return CliRunner().invoke(app, list(arguments))


def test_whoami_asks_the_api_with_the_saved_login_and_shows_the_answer(
    serve: Serve,
) -> None:
    credentials.save(a_login())
    seen = serve(
        lambda request: json_response(
            200,
            {
                "kind": "person",
                "email": "someone@sample-data.test",
                "roles": ["reader", "curator"],
                "powerbi_connection": {"state": "connected"},
                "note": "[not markup]",
            },
        )
    )

    result = run("whoami")

    assert result.exit_code == 0
    assert (seen[0].method, str(seen[0].url)) == ("GET", f"{URL}/api/v1/me")
    assert seen[0].headers["authorization"] == "Bearer saved-access"
    for expected in (
        "someone@sample-data.test",
        '["reader", "curator"]',
        '{"state": "connected"}',
        "[not markup]",
    ):
        assert expected in result.stdout
    with pytest.raises(json.JSONDecodeError):
        json.loads(result.stdout)


def test_the_url_before_the_command_beats_the_environment_and_the_saved_login(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")
    monkeypatch.setenv("PBMB_URL", "https://environment.test")
    credentials.save(a_login())
    seen = serve(lambda request: json_response(200, {"kind": "service_account"}))

    result = run("--url", "https://argument.test/", "whoami")

    assert result.exit_code == 0
    assert str(seen[0].url) == "https://argument.test/api/v1/me"


def test_an_answer_that_is_not_an_object_is_an_upstream_failure(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")
    monkeypatch.setenv("PBMB_URL", URL)
    serve(lambda request: json_response(200, ["not", "an", "object"]))

    result = run("whoami", "--json")

    assert result.exit_code == 1
    assert result.stdout == ""
    assert "did not answer who you are" in result.stderr
