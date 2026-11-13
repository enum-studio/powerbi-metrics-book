from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx
import pytest
from cli_support import (
    TOKEN_ENDPOINT,
    URL,
    Serve,
    a_login,
    api_error,
    json_response,
    new_tokens,
)

from powerbi_metrics_book import credentials
from powerbi_metrics_book.client import (
    ApiError,
    Client,
    NotSignedInError,
    UnreachableError,
)


def answer_me(request: httpx.Request) -> httpx.Response:
    return json_response(200, {"id": "someone"})


def test_with_an_api_key_and_a_saved_login_the_api_key_is_sent(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_from_the_environment")
    credentials.save(a_login())
    seen = serve(answer_me)

    answer = Client().get("/me")

    assert answer == {"id": "someone"}
    assert str(seen[0].url) == f"{URL}/api/v1/me"
    assert seen[0].headers["authorization"] == "Bearer pbmb_sk_from_the_environment"


def test_without_an_api_key_the_saved_token_is_sent(serve: Serve) -> None:
    credentials.save(a_login())
    seen = serve(answer_me)

    Client().get("/me")

    assert [request.headers["authorization"] for request in seen] == [
        "Bearer saved-access"
    ]


def test_without_credentials_the_client_says_to_sign_in() -> None:
    with pytest.raises(NotSignedInError, match=r"not signed in to https://x\.test"):
        Client("https://x.test")


def test_without_a_deployment_the_client_says_how_to_name_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")

    with pytest.raises(NotSignedInError, match="--url, set PBMB_URL"):
        Client()


@pytest.mark.parametrize(
    ("argument", "environment", "expected"),
    [
        ("https://argument.test", "https://environment.test", "argument"),
        (None, "https://environment.test", "environment"),
        (None, None, "book.sample-data"),
    ],
)
def test_the_deployment_is_the_argument_then_the_environment_then_the_saved_one(
    monkeypatch: pytest.MonkeyPatch,
    serve: Serve,
    argument: str | None,
    environment: str | None,
    expected: str,
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_key")
    if environment:
        monkeypatch.setenv("PBMB_URL", environment)
    credentials.save(a_login())
    seen = serve(answer_me)

    Client(argument).get("/me")

    assert expected in seen[0].url.host


def test_a_saved_login_is_never_sent_to_another_deployment(serve: Serve) -> None:
    credentials.save(a_login())
    seen = serve(answer_me)

    with pytest.raises(NotSignedInError, match=f"saved login is for {URL}"):
        Client("https://elsewhere.test")

    assert seen == []


def test_a_401_refreshes_once_saves_the_new_login_and_retries(serve: Serve) -> None:
    credentials.save(a_login())
    saved_when_retried: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            return new_tokens()
        if request.headers["authorization"] == "Bearer saved-access":
            return api_error(401, "unauthenticated", "Your token expired.")
        login = credentials.load()
        assert login is not None
        saved_when_retried.append(login.refresh_token)
        return json_response(200, {"id": "someone"})

    seen = serve(handler)

    answer = Client().get("/me")

    assert answer == {"id": "someone"}
    assert [(request.method, str(request.url)) for request in seen] == [
        ("GET", f"{URL}/api/v1/me"),
        ("POST", TOKEN_ENDPOINT),
        ("GET", f"{URL}/api/v1/me"),
    ]
    assert seen[2].headers["authorization"] == "Bearer new-access"
    assert parse_qs(seen[1].content.decode()) == {
        "grant_type": ["refresh_token"],
        "refresh_token": ["saved-refresh"],
        "client_id": ["pbmb-cli"],
        "resource": [f"{URL}/api/v1"],
    }
    # The rotated refresh token is on disk before the retried request is sent.
    assert saved_when_retried == ["new-refresh"]
    login = credentials.load()
    assert login is not None
    assert (login.access_token, login.refresh_token, login.url) == (
        "new-access",
        "new-refresh",
        URL,
    )
    assert login.expires_at > datetime.now(UTC) + timedelta(minutes=59)


def test_a_second_401_is_an_error_and_the_login_is_refreshed_only_once(
    serve: Serve,
) -> None:
    credentials.save(a_login())

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            return new_tokens()
        return api_error(401, "unauthenticated", "Sign in again.")

    seen = serve(handler)

    with pytest.raises(ApiError) as raised:
        Client().get("/me")

    assert (raised.value.kind, raised.value.status) == ("unauthenticated", 401)
    assert [request.method for request in seen] == ["GET", "POST", "GET"]


def test_a_401_straight_after_a_refresh_before_the_request_is_not_refreshed_again(
    serve: Serve,
) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) + timedelta(seconds=30)))

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            return new_tokens()
        return api_error(401, "unauthenticated", "Sign in again.")

    seen = serve(handler)

    with pytest.raises(ApiError, match=r"Sign in again\."):
        Client().get("/me")

    assert [request.method for request in seen] == ["POST", "GET"]


def test_a_refused_api_key_is_not_refreshed(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_revoked")
    credentials.save(a_login())
    seen = serve(lambda request: api_error(401, "unauthenticated", "Key revoked."))

    with pytest.raises(ApiError, match=r"Key revoked\."):
        Client().get("/me")

    assert len(seen) == 1


def test_a_token_a_minute_from_expiry_is_refreshed_before_the_request(
    serve: Serve,
) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) + timedelta(seconds=30)))

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            return new_tokens()
        return json_response(200, {"id": "someone"})

    seen = serve(handler)

    Client().get("/me")

    assert [request.method for request in seen] == ["POST", "GET"]
    assert seen[1].headers["authorization"] == "Bearer new-access"


def test_invalid_grant_deletes_the_saved_login_and_says_to_sign_in_again(
    serve: Serve,
) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    serve(lambda request: json_response(400, {"error": "invalid_grant"}))

    with pytest.raises(NotSignedInError, match="pbmb login"):
        Client().get("/me")

    assert credentials.load() is None


def test_a_refresh_that_fails_otherwise_keeps_the_saved_login(serve: Serve) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    serve(lambda request: httpx.Response(503, text="<html>maintenance</html>"))

    with pytest.raises(ApiError, match="Refreshing your login failed") as raised:
        Client().get("/me")

    assert (raised.value.kind, raised.value.status) == ("upstream", 503)
    assert credentials.load() is not None


def test_the_apis_error_shape_becomes_an_api_error(serve: Serve) -> None:
    credentials.save(a_login())
    serve(lambda request: api_error(404, "not_found", "No metric called margin."))

    with pytest.raises(ApiError) as raised:
        Client().get("/metrics/margin")

    assert (raised.value.kind, raised.value.message, raised.value.status) == (
        "not_found",
        "No metric called margin.",
        404,
    )


def test_an_answer_without_the_error_shape_is_an_upstream_error(
    serve: Serve,
) -> None:
    credentials.save(a_login())
    serve(lambda request: httpx.Response(502, text="<html>Bad gateway</html>"))

    with pytest.raises(ApiError, match="answered 502") as raised:
        Client().get("/me")

    assert raised.value.kind == "upstream"


def test_a_success_that_is_not_json_names_the_likely_mistake(serve: Serve) -> None:
    credentials.save(a_login())
    serve(lambda request: httpx.Response(200, text="<html>Sign in</html>"))

    with pytest.raises(ApiError, match="did not answer JSON"):
        Client().get("/me")


def test_a_request_sends_its_query_and_json_body_with_a_60_second_timeout(
    serve: Serve,
) -> None:
    credentials.save(a_login())
    seen = serve(lambda request: httpx.Response(204))

    answer = Client().request(
        "POST", "/metrics", query={"limit": 5}, body={"key": "net_sales"}
    )

    assert answer is None
    assert seen[0].url.query == b"limit=5"
    assert seen[0].content == b'{"key":"net_sales"}'
    assert seen[0].extensions["timeout"]["read"] == 60


def test_an_unreachable_deployment_is_an_error_with_its_address(
    serve: Serve,
) -> None:
    credentials.save(a_login())

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    serve(refuse)

    with pytest.raises(UnreachableError, match=f"Cannot reach {URL}") as raised:
        Client().get("/me")

    assert str(raised.value).endswith("Connection refused.")


def test_an_unreachable_token_endpoint_is_named_and_its_reason_ends_once(
    serve: Serve,
) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(minutes=1)))

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused.")

    serve(refuse)

    with pytest.raises(UnreachableError) as raised:
        Client().get("/me")

    assert str(raised.value) == f"Cannot reach {TOKEN_ENDPOINT}: Connection refused."


def test_a_token_answer_missing_the_refresh_token_is_an_error_and_keeps_the_login(
    serve: Serve,
) -> None:
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    serve(
        lambda request: json_response(200, {"access_token": "new", "expires_in": 3600})
    )

    with pytest.raises(
        ApiError, match="without an access token, refresh token"
    ) as raised:
        Client().get("/me")

    assert raised.value.kind == "upstream"
    saved = credentials.load()
    assert saved is not None and saved.refresh_token == a_login().refresh_token
