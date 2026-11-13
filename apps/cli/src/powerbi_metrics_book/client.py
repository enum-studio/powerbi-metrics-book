"""Every remote command's way to /api/v1: which deployment, who is calling, and
what the api's errors become."""

import ipaddress
import math
import os
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
import typer

from powerbi_metrics_book import credentials
from powerbi_metrics_book.credentials import Login

type Json = dict[str, Json] | list[Json] | str | int | float | bool | None
type Query = Mapping[str, str | int | bool]

TIMEOUT_SECONDS = 60
# A token this close to its expiry is refreshed first, so a request does not
# set out with one that dies on the way.
REFRESH_MARGIN = timedelta(seconds=60)
# No access token is trusted for longer than this, whatever the deployment says.
MAX_TOKEN_SECONDS = 24 * 60 * 60


class ApiError(Exception):
    """The api's `{ "error": kind, "message": ... }`, with the HTTP status."""

    def __init__(self, kind: str, message: str, status: int) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status


def api_path(*segments: str, answered_by_api: bool = False) -> str:
    """A request path from its segments, each escaped as one segment.

    An id or a name typed on the command line, or answered by the server, can
    hold `/`, `#`, `?` or `..`; escaped, it stays a single segment under the
    route the command means. A segment that is empty, `.` or `..` is refused with
    a usage error (exit 2), because a client would collapse it out of the path.
    Pass answered_by_api for an id the server sent: that is its fault, not a
    typing mistake, so it is an ApiError.
    """
    for segment in segments:
        if segment in ("", ".", ".."):
            if answered_by_api:
                raise ApiError(
                    "upstream",
                    "The api answered an id the CLI will not use: it is empty, "
                    "'.' or '..'.",
                    200,
                )
            raise typer.BadParameter(
                "A name or id in this request is empty, '.' or '..'. Check what "
                "you typed."
            )
    return "".join(f"/{quote(segment, safe='')}" for segment in segments)


def require_secure_url(url: str) -> None:
    """Refuses a deployment address a token must not be sent to.

    https is accepted anywhere; http only on this machine (`localhost`,
    127.0.0.0/8, `::1`), where nothing crosses a network. A name such as
    `x.localhost` is not trusted: the resolver decides where it goes. It
    is a usage error (exit 2), raised before any request is made.
    """
    try:
        address = httpx.URL(url)
    except httpx.InvalidURL as error:
        raise typer.BadParameter(
            "The deployment address is not a web address."
        ) from error
    host = address.host
    if address.scheme == "https" and host:
        return
    if address.scheme == "http" and (host == "localhost" or _is_loopback(host)):
        return
    raise typer.BadParameter(
        f"{address.scheme}://{host} would send your login over the network "
        "unencrypted. Use an https:// address (http:// works only for localhost)."
    )


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def seconds_from(found: Json, name: str, cap: float) -> float:
    """A wait or a lifetime the deployment named: a finite number above zero,
    at most cap. Anything else, a bool or NaN included, is the api's fault."""
    if (
        isinstance(found, bool)
        or not isinstance(found, int | float)
        or (isinstance(found, float) and not math.isfinite(found))
        or found <= 0
    ):
        raise ApiError(
            "upstream", f"The api answered a {name} that is not a positive number.", 200
        )
    return min(found, cap)


class NotSignedInError(Exception):
    pass


class UnreachableError(Exception):
    pass


class Client:
    """Calls `{url}/api/v1` as whoever the credentials say.

    The url is `url`, else PBMB_URL, else the one saved at login. Credentials
    are PBMB_API_KEY, else the saved login, which is refreshed through its
    refresh token when it is about to expire or the api answers 401, at most
    once per request. A saved login is only ever sent to its own deployment.
    use_api_key=False ignores PBMB_API_KEY, for a command that must act as the
    saved login.
    """

    def __init__(self, url: str | None = None, *, use_api_key: bool = True) -> None:
        explicit = (url or os.environ.get("PBMB_URL") or "").rstrip("/") or None
        api_key = (os.environ.get("PBMB_API_KEY") if use_api_key else None) or None
        saved = None if api_key and explicit else credentials.load()
        base = explicit or (saved.url.rstrip("/") if saved else None)
        if base is None:
            raise NotSignedInError(
                "No deployment to talk to. Pass --url, set PBMB_URL, "
                "or run `pbmb login`."
            )
        require_secure_url(base)
        self.url = base
        self._login: Login | None = None
        if api_key:
            self._token = api_key
        elif saved and saved.url.rstrip("/") == base:
            self._token = saved.access_token
            self._login = saved
        else:
            other = f" (your saved login is for {saved.url})" if saved else ""
            raise NotSignedInError(
                f"You are not signed in to {base}{other}. "
                "Run `pbmb login`, or set PBMB_API_KEY."
            )
        self._http = httpx.Client(base_url=f"{base}/api/v1", timeout=TIMEOUT_SECONDS)

    def close(self) -> None:
        self._http.close()

    def get(self, path: str, query: Query | None = None) -> Json:
        return self.request("GET", path, query=query)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Query | None = None,
        body: Json = None,
    ) -> Json:
        """The answer's JSON (None for a 204). Raises ApiError, NotSignedInError
        or UnreachableError."""
        refreshed = False
        if self._login and self._login.expires_at - datetime.now(UTC) <= REFRESH_MARGIN:
            self._refresh(self._login)
            refreshed = True
        response = self._send(method, path, query, body)
        if response.status_code == 401 and self._login and not refreshed:
            self._refresh(self._login)
            response = self._send(method, path, query, body)
        return self._decode(response)

    def _send(
        self, method: str, path: str, query: Query | None, body: Json
    ) -> httpx.Response:
        request = self._http.build_request(
            method,
            path,
            params=query,
            json=body,
            headers={"Authorization": f"Bearer {self._token}"},
        )
        return self._transmit(request, self.url)

    def _transmit(self, request: httpx.Request, address: str) -> httpx.Response:
        try:
            return self._http.send(request)
        except httpx.TransportError as error:
            reason = (str(error) or type(error).__name__).rstrip(".")
            raise UnreachableError(f"Cannot reach {address}: {reason}.") from error

    def _decode(self, response: httpx.Response) -> Json:
        if response.is_success:
            if response.status_code == 204:
                return None
            try:
                answer: Json = response.json()
            except ValueError as error:
                raise ApiError(
                    "upstream",
                    f"{self.url} did not answer JSON. Is it a Power BI Metrics "
                    "Book deployment?",
                    response.status_code,
                ) from error
            return answer
        kind, message = _field(response, "error"), _field(response, "message")
        if isinstance(kind, str) and isinstance(message, str):
            raise ApiError(kind, message, response.status_code)
        raise ApiError(
            "upstream",
            f"{self.url} answered {response.status_code} without an error message.",
            response.status_code,
        )

    def _refresh(self, login: Login) -> None:
        response = self._transmit(
            self._http.build_request(
                "POST",
                login.token_endpoint,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": login.refresh_token,
                    "client_id": login.client_id,
                    "resource": f"{login.url.rstrip('/')}/api/v1",
                },
            ),
            login.token_endpoint,
        )
        if not response.is_success:
            if _field(response, "error") == "invalid_grant":
                current = credentials.load()
                if (
                    current is not None
                    and current.refresh_token != login.refresh_token
                    and current.url.rstrip("/") == login.url.rstrip("/")
                ):
                    # Another process spent that refresh token first and saved
                    # the new one: use it, and leave it on disk.
                    self._login = current
                    self._token = current.access_token
                    return
                if current is not None:
                    credentials.delete()
                self._login = None
                raise NotSignedInError(
                    "Your login has expired or was revoked. "
                    "Run `pbmb login` to sign in again."
                )
            raise ApiError(
                "upstream",
                f"Refreshing your login failed: {login.token_endpoint} "
                f"answered {response.status_code}.",
                response.status_code,
            )
        access_token = _field(response, "access_token")
        refresh_token = _field(response, "refresh_token")
        lifetime = _field(response, "expires_in")
        if not (
            isinstance(access_token, str)
            and isinstance(refresh_token, str)
            and lifetime is not None
        ):
            raise ApiError(
                "upstream",
                f"{login.token_endpoint} answered without an access token, "
                "refresh token and lifetime.",
                response.status_code,
            )
        renewed = replace(
            login,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=datetime.now(UTC)
            + timedelta(
                seconds=seconds_from(lifetime, "expires_in", MAX_TOKEN_SECONDS)
            ),
        )
        # The refresh token rotates: the old one is spent, so the new one is on
        # disk before anything else can fail.
        credentials.save(renewed)
        self._login = renewed
        self._token = renewed.access_token


def _field(response: httpx.Response, name: str) -> Json:
    """One field of a JSON object body; None for any other body, such as a
    proxy's HTML error page."""
    try:
        body: Json = response.json()
    except ValueError:
        return None
    return body.get(name) if isinstance(body, dict) else None
