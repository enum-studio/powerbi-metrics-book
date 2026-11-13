"""Helpers the CLI tests share. Fixtures stay in conftest.py; helpers live here,
since `conftest` is not a unique module name once two test folders have one."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from powerbi_metrics_book import credentials
from powerbi_metrics_book.credentials import Login

type Handler = Callable[[httpx.Request], httpx.Response]
type Serve = Callable[[Handler], list[httpx.Request]]

URL = "https://book.sample-data.test"
TOKEN_ENDPOINT = f"{URL}/api/auth/oauth2/token"


def a_login(
    *,
    url: str = URL,
    token_endpoint: str = TOKEN_ENDPOINT,
    access_token: str = "saved-access",
    refresh_token: str = "saved-refresh",
    expires_at: datetime | None = None,
) -> Login:
    return Login(
        url=url,
        client_id=credentials.CLIENT_ID,
        token_endpoint=token_endpoint,
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=expires_at or datetime.now(UTC) + timedelta(hours=1),
    )


def json_response(status: int, body: object) -> httpx.Response:
    return httpx.Response(status, json=body)


def api_error(status: int, kind: str, message: str) -> httpx.Response:
    return json_response(status, {"error": kind, "message": message})


def new_tokens(lifetime_seconds: int = 3600) -> httpx.Response:
    return json_response(
        200,
        {
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "token_type": "Bearer",
            "expires_in": lifetime_seconds,
        },
    )
