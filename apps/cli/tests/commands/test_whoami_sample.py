"""pbmb whoami on the sample tenant: a Tenant line for people, --json as it is."""

import json

import pytest
from cli_support import URL, Serve, json_response
from commands_support import run

TENANT_LINE = "Tenant"
SAMPLE_SENTENCE = "the sample tenant: invented data, not your company's"


@pytest.fixture(autouse=True)
def signed_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")
    monkeypatch.setenv("PBMB_URL", URL)


def test_whoami_ends_with_the_tenant_line_on_the_sample_tenant(serve: Serve) -> None:
    serve(
        lambda request: json_response(
            200, {"kind": "person", "roles": ["admin"], "sample_data": True}
        )
    )

    result = run("whoami")

    assert result.exit_code == 0
    lines = [line.split() for line in result.stdout.strip().splitlines()]
    assert lines[-1] == [TENANT_LINE, *SAMPLE_SENTENCE.split()]
    assert "sample_data" not in result.stdout
    assert "kind" in result.stdout


def test_whoami_says_nothing_of_the_sample_when_the_tenant_is_real(
    serve: Serve,
) -> None:
    serve(
        lambda request: json_response(
            200, {"kind": "person", "roles": ["admin"], "sample_data": False}
        )
    )

    result = run("whoami")

    assert result.exit_code == 0
    assert TENANT_LINE not in result.stdout
    assert "sample tenant" not in result.stdout


def test_whoami_json_keeps_the_answer_as_it_is(serve: Serve) -> None:
    answer = {
        "kind": "person",
        "roles": ["admin"],
        "sample_data": True,
        "usage": {"capture": True, "retention_days": 180},
    }
    serve(lambda request: json_response(200, answer))

    result = run("whoami", "--json")

    assert result.exit_code == 0
    assert json.loads(result.stdout) == answer


def test_whoami_shows_usage_for_people(serve: Serve) -> None:
    serve(
        lambda request: json_response(
            200, {"usage": {"capture": False, "retention_days": 30}}
        )
    )
    result = run("whoami")
    assert result.exit_code == 0
    assert '"capture": false' in result.stdout
    assert '"retention_days": 30' in result.stdout
