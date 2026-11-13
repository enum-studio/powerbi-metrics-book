import json
import os
import re
import time
import webbrowser
from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Annotated

import httpx
import typer

from powerbi_metrics_book import credentials
from powerbi_metrics_book.answers import object_of, one_line, plain, string_field
from powerbi_metrics_book.calls import revoke_cli_grants
from powerbi_metrics_book.client import (
    MAX_TOKEN_SECONDS,
    TIMEOUT_SECONDS,
    ApiError,
    Client,
    Json,
    NotSignedInError,
    UnreachableError,
    require_secure_url,
    seconds_from,
)
from powerbi_metrics_book.credentials import CLIENT_ID, CredentialsError, Login
from powerbi_metrics_book.output import JsonOption, Settings, exit_code

# What an address may hold (RFC 3986); a browser may read anything else, such as
# a backslash, as a different address than the one shown.
RFC3986_CHARACTERS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
# RFC 8628: what slow_down adds. The deployment's numbers are kept inside
# bounds a person would accept.
SLOW_DOWN_SECONDS = 5
INTERVAL_SECONDS = (5, 60)
MAX_DEVICE_CODE_SECONDS = 1800


def _call(
    http: httpx.Client, method: str, endpoint: str, form: dict[str, str] | None = None
) -> httpx.Response:
    try:
        return http.request(method, endpoint, data=form)
    except httpx.TransportError as error:
        reason = (str(error) or type(error).__name__).rstrip(".")
        raise UnreachableError(f"Cannot reach {endpoint}: {reason}.") from error


def _answer(response: httpx.Response) -> dict[str, Json]:
    try:
        return object_of(response.json(), "the login")
    except ValueError as error:
        raise ApiError(
            "upstream",
            f"{response.url} did not answer JSON. Is it a Power BI Metrics Book "
            "deployment?",
            response.status_code,
        ) from error


def _own_address(base: str, address: str, what: str) -> str:
    """address, which the deployment named, if it is on the deployment's own host.

    The device code and the tokens go to these addresses, so a document that
    points them elsewhere is refused before anything is sent.
    """
    try:
        ours, named = httpx.URL(base), httpx.URL(address)
    except httpx.InvalidURL as error:
        raise ApiError(
            "upstream", f"{base} named {what} that is not an address.", 200
        ) from error
    if (ours.scheme, ours.host, ours.port) != (named.scheme, named.host, named.port):
        raise ApiError(
            "upstream",
            f"{base} named {what} {one_line(address)}, which is on another host. "
            "Not sending your login there.",
            200,
        )
    return address


def _check_issuer(base: str, issuer: str) -> None:
    """The deployment publishes `<its address>/api/auth` as its issuer; a
    document that names another one is not this deployment's."""
    try:
        same = httpx.URL(issuer) == httpx.URL(f"{base}/api/auth")
    except httpx.InvalidURL:
        same = False
    if not same:
        raise ApiError(
            "upstream",
            f"{base} published the issuer {one_line(issuer)}, not its own. "
            "Not signing in.",
            200,
        )


def _sign_in(http: httpx.Client, base: str, open_browser: bool) -> Login:
    discovery = _answer(
        _call(http, "GET", f"{base}/.well-known/oauth-authorization-server")
    )
    _check_issuer(base, string_field(discovery, "issuer"))
    device_endpoint = _own_address(
        base,
        string_field(discovery, "device_authorization_endpoint"),
        "the device authorization endpoint",
    )
    token_endpoint = _own_address(
        base, string_field(discovery, "token_endpoint"), "the token endpoint"
    )
    started = _call(
        http,
        "POST",
        device_endpoint,
        {
            "client_id": CLIENT_ID,
            "scope": "api offline_access",
            "resource": f"{base}/api/v1",
        },
    )
    device = _answer(started)
    if not started.is_success:
        raise ApiError(
            "upstream",
            f"{device_endpoint} refused the login: {one_line(device.get('error'))}.",
            started.status_code,
        )
    verification_uri = str(
        httpx.URL(
            _own_address(
                base, string_field(device, "verification_uri"), "the page to open"
            )
        )
    )
    if not RFC3986_CHARACTERS.fullmatch(verification_uri):
        raise ApiError(
            "upstream",
            f"{base} named a page to open with characters an address may not "
            f"hold: {one_line(verification_uri)}. Not opening it.",
            200,
        )
    lifetime = seconds_from(
        device.get("expires_in"), "expires_in", MAX_DEVICE_CODE_SECONDS
    )
    typer.echo(
        plain(
            f"\nOpen {one_line(verification_uri)} and type this code, if you "
            f"started this login:\n\n"
            f"    {one_line(string_field(device, 'user_code'))}\n\n"
            "Waiting for you to allow it..."
        ),
        err=True,
    )
    if open_browser:
        webbrowser.open(verification_uri)
    low, high = INTERVAL_SECONDS
    if "interval" in device:
        interval = max(low, seconds_from(device["interval"], "interval", high))
    else:
        interval = low
    deadline = time.monotonic() + lifetime
    while time.monotonic() < deadline:
        time.sleep(interval)
        response = _call(
            http,
            "POST",
            token_endpoint,
            {
                "grant_type": DEVICE_GRANT,
                "device_code": string_field(device, "device_code"),
                "client_id": CLIENT_ID,
            },
        )
        answer = _answer(response)
        if response.is_success:
            return _login(base, token_endpoint, answer)
        error = answer.get("error")
        if error == "slow_down":
            interval = min(interval + SLOW_DOWN_SECONDS, high)
        elif error == "access_denied":
            raise ApiError(
                "access_denied",
                "You denied the request. Run `pbmb login` to try again.",
                response.status_code,
            )
        elif error == "expired_token":
            break
        elif error != "authorization_pending":
            raise ApiError(
                "upstream",
                f"{token_endpoint} refused the login: {one_line(error)}.",
                response.status_code,
            )
    raise ApiError(
        "expired_token",
        "The code expired before you allowed it. Run `pbmb login` to get a new one.",
        400,
    )


def _login(base: str, token_endpoint: str, answer: dict[str, Json]) -> Login:
    access_token = answer.get("access_token")
    refresh_token = answer.get("refresh_token")
    lifetime = answer.get("expires_in")
    if not (
        isinstance(access_token, str)
        and isinstance(refresh_token, str)
        and lifetime is not None
    ):
        raise ApiError(
            "upstream",
            f"{token_endpoint} answered without an access token, refresh token "
            "and lifetime.",
            200,
        )
    return Login(
        url=base,
        client_id=CLIENT_ID,
        token_endpoint=token_endpoint,
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=datetime.now(UTC)
        + timedelta(seconds=seconds_from(lifetime, "expires_in", MAX_TOKEN_SECONDS)),
    )


def command(
    context: typer.Context,
    url: Annotated[
        str | None,
        typer.Option(
            help="The deployment, such as https://book.example.com. "
            "Else PBMB_URL, else the one you signed in to before."
        ),
    ] = None,
    open_browser: Annotated[
        bool, typer.Option("--open", help="Open the page in your browser.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Sign in to a deployment: it shows a page and a code, you allow it there.

    Example: pbmb login --url https://book.example.com

    Type the code at the page shown. Nothing opens by itself unless you pass
    --open. The login is saved for your user only, and every other command
    uses it until it is revoked; `pbmb logout` ends it.
    """
    settings = context.ensure_object(Settings)
    try:
        saved = credentials.load()
        unreadable = False
    except CredentialsError:
        saved, unreadable = None, True
    chosen = url or settings.url or os.environ.get("PBMB_URL")
    if chosen is None and saved is not None:
        chosen = saved.url
    if chosen is None:
        raise typer.BadParameter(
            "Pass --url, or set PBMB_URL."
            + (" The login saved on this machine cannot be read." if unreadable else "")
        )
    base = chosen.rstrip("/")
    require_secure_url(base)
    try:
        with httpx.Client(base_url=base, timeout=TIMEOUT_SECONDS) as http:
            login = _sign_in(http, base, open_browser)
        if unreadable:
            typer.echo(
                "The login saved on this machine could not be read, so it was "
                "not revoked.",
                err=True,
            )
        elif saved is not None and saved.url.rstrip("/") != base:
            _revoke_earlier(saved)
        credentials.save(login)
    except (ApiError, UnreachableError, CredentialsError) as error:
        typer.echo(plain(str(error)), err=True)
        raise typer.Exit(exit_code(error)) from error
    if settings.as_json or json_output:
        typer.echo(
            json.dumps(
                {"url": base, "expires_at": login.expires_at.isoformat()}, indent=2
            )
        )
    else:
        typer.echo(plain(f"Signed in to {base}."))


def _revoke_earlier(earlier: Login) -> None:
    """Ends the login this one replaces, if it can; says so if it cannot."""
    try:
        with closing(Client(earlier.url, use_api_key=False)) as client:
            revoke_cli_grants(client)
    except (
        ApiError,
        NotSignedInError,
        UnreachableError,
        CredentialsError,
        typer.BadParameter,
    ) as error:
        typer.echo(
            plain(
                f"Your earlier login to {earlier.url} was not revoked: "
                f"{one_line(str(error))} "
                f"Revoke it at {earlier.url}/settings/connections."
            ),
            err=True,
        )
