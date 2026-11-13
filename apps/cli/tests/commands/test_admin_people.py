import json

import httpx
import pytest
from cli_support import Serve, json_response
from commands_support import run, sent


@pytest.mark.parametrize("as_json", [False, True])
@pytest.mark.parametrize(
    "command,method,suffix",
    [
        ("deactivate", "POST", "/deactivate"),
        ("reactivate", "POST", "/reactivate"),
        ("role", "PUT", "/role"),
        ("delete", "DELETE", ""),
        ("resend", "POST", "/resend"),
        ("revoke-invite", "DELETE", ""),
    ],
)
def test_people_mutations(
    serve: Serve, command: str, method: str, suffix: str, as_json: bool
) -> None:
    invites = command in ("resend", "revoke-invite")
    key = "invites" if invites else "people"
    path = "/api/v1/admin/people" + ("/invites" if invites else "")
    answer = {
        "expires_at": "2026-11-15T00:00:00Z",
        "link": "https://sample.test/invite",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return json_response(
                200,
                {
                    key: [
                        {"id": "other", "email": "b@example.com"},
                        {"id": "target", "email": "a@example.com"},
                    ]
                },
            )
        return (
            json_response(200, answer) if command == "resend" else httpx.Response(204)
        )

    seen = serve(handler)
    arguments = ["admin", "people", command, "a@example.com"]
    if command == "role":
        arguments.append("curator")
    result = run(*arguments, *(["--json"] if as_json else []), input="a@example.com\n")
    assert result.exit_code == 0, result.output
    assert [(r.method, r.url.path) for r in seen] == [
        ("GET", path),
        (method, path + "/target" + suffix),
    ]
    if command == "role":
        assert sent(seen[1]) == {"role": "curator"}
    if as_json:
        assert json.loads(result.stdout) == (
            answer if command == "resend" else {"email": "a@example.com", "done": True}
        )
    elif command == "resend":
        assert answer["link"] in result.stdout


@pytest.mark.parametrize("as_json", [False, True])
@pytest.mark.parametrize("link", [None, "https://sample.test/invite/replacement"])
def test_resend_output(serve: Serve, as_json: bool, link: str | None) -> None:
    answer = {"expires_at": "2026-11-15T00:00:00Z", "link": link}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return json_response(
                200, {"invites": [{"id": "target", "email": "a@example.com"}]}
            )
        return json_response(200, answer)

    serve(handler)
    result = run(
        "admin", "people", "resend", "a@example.com", *(["--json"] if as_json else [])
    )
    assert result.exit_code == 0, result.output
    if as_json:
        assert json.loads(result.stdout) == answer
    else:
        expected = "Resent the invite to a@example.com.\n"
        if link is not None:
            expected += link + "\n"
        assert result.stdout == expected


@pytest.mark.parametrize("command", ["deactivate", "revoke-invite"])
def test_missing_email_never_mutates(serve: Serve, command: str) -> None:
    seen = serve(lambda request: json_response(200, {"people": [], "invites": []}))
    result = run("admin", "people", command, "missing@example.com", "--json")
    assert result.exit_code == 4
    assert "missing@example.com" in result.stderr
    assert [r.method for r in seen] == ["GET"]


@pytest.mark.parametrize("confirmation", ["other@example.com\n", ""])
def test_delete_requires_matching_confirmation(serve: Serve, confirmation: str) -> None:
    seen = serve(lambda request: httpx.Response(204))
    result = run(
        "admin", "people", "delete", "a@example.com", "--json", input=confirmation
    )
    assert result.exit_code != 0
    assert seen == []


@pytest.mark.parametrize("as_json", [False, True])
@pytest.mark.parametrize("link", [False, True])
def test_batch_invites(serve: Serve, as_json: bool, link: bool) -> None:
    emails = ["a@example.com", "b@example.com"]
    answer = {
        "invites": [
            {
                "id": email,
                "email": email,
                "expires_at": "2026-11-15T00:00:00Z",
                "link": "https://sample.test/" + email if link else None,
            }
            for email in emails
        ]
    }
    seen = serve(lambda request: json_response(200, answer))
    arguments = [
        "admin",
        "people",
        "invite",
        *emails,
        "--role",
        "custom_reader",
        "--custom",
    ]
    result = run(
        *arguments, *(["--link"] if link else []), *(["--json"] if as_json else [])
    )
    assert result.exit_code == 0, result.output
    assert sent(seen[0]) == {
        "emails": emails,
        "role": "custom_reader",
        "custom": True,
        "delivery": "link" if link else "email",
    }
    if as_json:
        assert json.loads(result.stdout) == answer
    else:
        for email in emails:
            assert email in result.stdout
            if link:
                assert result.stdout.count("https://sample.test/" + email) == 1


@pytest.mark.parametrize("as_json", [False, True])
def test_invites_include_expired(serve: Serve, as_json: bool) -> None:
    answer = {
        "invites": [
            {
                "id": str(expired),
                "email": f"{expired}@example.com",
                "role": "viewer",
                "delivery": "email",
                "inviter_name": "Sample Admin",
                "last_sent_at": "2026-11-01T00:00:00Z",
                "expires_at": "2026-11-08T00:00:00Z",
                "expired": expired,
            }
            for expired in [False, True]
        ]
    }
    seen = serve(lambda request: json_response(200, answer))
    result = run("admin", "people", "invites", *(["--json"] if as_json else []))
    assert result.exit_code == 0, result.output
    assert seen[0].url.path == "/api/v1/admin/people/invites"
    if as_json:
        assert json.loads(result.stdout) == answer
    else:
        assert (
            "False@example.com" in result.stdout and "True@example.com" in result.stdout
        )
