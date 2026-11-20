"""login and logout, and the commands that find things: search, workspaces,
apps, datasets, columns, measures and docs."""

import json
import os
import stat
import time
import webbrowser
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
import typer
from cli_support import TOKEN_ENDPOINT, URL, Serve, a_login, api_error, json_response
from commands_support import run

from powerbi_metrics_book import credentials
from powerbi_metrics_book.cli import app
from powerbi_metrics_book.client import require_secure_url

DEVICE_ENDPOINT = f"{URL}/api/auth/oauth2/device/code"
DEVICE_ANSWER = {
    "device_code": "dev-secret-123",
    "user_code": "ABCD-EFGH",
    "verification_uri": f"{URL}/device",
    "expires_in": 600,
    "interval": 5,
}
TOKENS = {
    "access_token": "access-secret-1",
    "refresh_token": "refresh-secret-1",
    "token_type": "Bearer",
    "expires_in": 3600,
}
# Reverses the text after it on a terminal.
BIDI = chr(0x202E)
SECRETS = ("dev-secret-123", "access-secret-1", "refresh-secret-1")


def oauth_error(kind: str) -> httpx.Response:
    return json_response(400, {"error": kind})


def sign_in_server(
    token_answers: list[httpx.Response],
    endpoints: dict[str, str] | None = None,
    device: dict[str, object] | None = None,
) -> Callable[[httpx.Request], httpx.Response]:
    remaining = list(token_answers)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/.well-known/oauth-authorization-server":
            return json_response(
                200,
                {
                    "issuer": f"{URL}/api/auth",
                    "device_authorization_endpoint": DEVICE_ENDPOINT,
                    "token_endpoint": TOKEN_ENDPOINT,
                    **(endpoints or {}),
                },
            )
        if str(request.url) == DEVICE_ENDPOINT:
            return httpx.Response(
                200,
                content=json.dumps({**DEVICE_ANSWER, **(device or {})}),
                headers={"content-type": "application/json"},
            )
        assert str(request.url) == TOKEN_ENDPOINT
        return remaining.pop(0)

    return handler


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", slept.append)
    return slept


def test_login_polls_through_pending_and_slow_down_then_saves_the_tokens_0600(
    serve: Serve, waits: list[float]
) -> None:
    seen = serve(
        sign_in_server(
            [
                oauth_error("authorization_pending"),
                oauth_error("slow_down"),
                json_response(200, TOKENS),
            ]
        )
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 0, result.stderr
    assert waits == [5, 5, 10]
    assert "ABCD-EFGH" in result.stderr
    assert f"{URL}/device" in result.stderr
    assert f"Signed in to {URL}" in result.stdout
    assert parse_qs(seen[1].content.decode()) == {
        "client_id": ["pbmb-cli"],
        "scope": ["api offline_access"],
        "resource": [f"{URL}/api/v1"],
    }
    assert parse_qs(seen[2].content.decode()) == {
        "grant_type": ["urn:ietf:params:oauth:grant-type:device_code"],
        "device_code": ["dev-secret-123"],
        "client_id": ["pbmb-cli"],
    }
    saved = credentials.load()
    assert saved is not None
    assert (saved.url, saved.client_id, saved.token_endpoint) == (
        URL,
        "pbmb-cli",
        TOKEN_ENDPOINT,
    )
    assert (saved.access_token, saved.refresh_token) == (
        "access-secret-1",
        "refresh-secret-1",
    )
    assert stat.S_IMODE(credentials.credentials_path().stat().st_mode) == 0o600
    for secret in SECRETS:
        assert secret not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("kind", "sentence"),
    [("expired_token", "expired"), ("access_denied", "denied")],
)
def test_login_that_ends_before_success_saves_nothing(
    serve: Serve, waits: list[float], kind: str, sentence: str
) -> None:
    serve(sign_in_server([oauth_error("authorization_pending"), oauth_error(kind)]))

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert sentence in result.stderr
    assert "pbmb login" in result.stderr
    assert credentials.load() is None


def test_login_json_is_one_document_without_tokens(
    serve: Serve, waits: list[float]
) -> None:
    serve(sign_in_server([json_response(200, TOKENS)]))

    result = run("login", "--url", URL, "--json")

    assert result.exit_code == 0, result.stderr
    document = json.loads(result.stdout)
    assert document["url"] == URL
    assert "expires_at" in document
    for secret in SECRETS:
        assert secret not in result.stdout


def test_login_never_sends_a_device_code_to_another_host(
    serve: Serve, waits: list[float]
) -> None:
    seen = serve(
        sign_in_server([], endpoints={"token_endpoint": "https://evil.test/token"})
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert "evil.test" in result.stderr
    assert [request.url.host for request in seen] == ["book.sample-data.test"]


@pytest.mark.parametrize("flag", [[], ["--open"]])
def test_login_opens_the_browser_only_when_asked(
    monkeypatch: pytest.MonkeyPatch,
    serve: Serve,
    waits: list[float],
    flag: list[str],
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    serve(sign_in_server([json_response(200, TOKENS)]))

    run("login", "--url", URL, *flag)

    assert opened == ([f"{URL}/device"] if flag else [])


def test_logout_revokes_the_cli_grant_and_deletes_the_saved_login(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login())
    grants = {
        "grants": [
            {"id": "g/1", "client_id": "pbmb-cli", "via": "cli"},
            {"id": "g-2", "client_id": "claude-desktop", "via": "mcp"},
        ]
    }
    seen = serve(
        lambda request: (
            json_response(200, grants)
            if request.method == "GET"
            else httpx.Response(204)
        )
    )

    result = run("logout", "--json")

    assert result.exit_code == 0, result.stderr
    assert json.loads(result.stdout) == {"signed_out": True, "revoked_grants": 1}
    assert [(r.method, r.url.raw_path) for r in seen] == [
        ("GET", b"/api/v1/me/grants"),
        ("DELETE", b"/api/v1/me/grants/g%2F1"),
    ]
    assert credentials.load() is None


def test_logout_refuses_to_run_as_an_api_key(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("logout")

    assert result.exit_code == 2
    assert "PBMB_API_KEY" in result.stderr
    assert seen == []


def ref(kind: str, identifier: str, name: str) -> dict[str, str]:
    return {"kind": kind, "id": identifier, "name": name}


DATASET_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
OTHER_ID = "0b9e6679-7425-40de-944b-e07fc1f90ae7"
SALES = ref("workspace", "ws_1", "Sales")
WORKSPACE = {**SALES, "dataset_count": 3}
APP = {
    **ref("app", "app_1", "Sales app"),
    "workspace": SALES,
    "datasets": [
        ref("dataset", "ds_1", "Sales model"),
        ref("dataset", "ds_2", "Returns"),
    ],
}
DATASET = {**ref("dataset", DATASET_ID, "Sales model"), "workspace": SALES}
DETAIL = {
    **DATASET,
    "description_pbi": "Orders and returns.\x1b]0;pwned\x07",
    "apps": [ref("app", "app_1", "Sales app")],
    "endorsement": "Certified",
    "tables": [
        {**ref("table", "tb_1", "Orders"), "column_count": 12, "measure_count": 4}
    ],
}
COLUMN = {
    **ref("column", "col_1", "Country"),
    "table": ref("table", "tb_1", "Customers"),
    "data_type": "string",
    "description": "Where the order ships.",
}
MEASURE = {
    **ref("measure", "ms_1", "Net revenue"),
    "table": ref("table", "tb_1", "Orders"),
    "display_folder": "Revenue",
    "metric": None,
}
HIT = {
    **ref("metric", "mt_1", "net_revenue"),
    "summary": "Sales after returns.",
    "dataset": ref("dataset", "ds_1", "Sales model"),
    "trust_state": "human_verified",
    "match": "words",
}
DOCS = {
    "element": ref("column", DATASET_ID, "Country"),
    "description": "Where it ships.",
    "described_by": "ada@sample-data.test",
    "custom": {},
}


def test_search_sends_the_filters_and_prints_the_hits_and_the_note(
    serve: Serve,
) -> None:
    seen = serve(
        lambda request: json_response(
            200,
            {"items": [HIT], "search_mode": "words_only", "note": "Words only."},
        )
    )

    result = run(
        *("search", "net", "revenue", "--kind", "metric", "--kind", "term"),
        *("--trust-state", "human_verified,agent_verified", "--workspace", "Sales"),
        *("--app", "Sales app", "--dataset", "Sales model", "--category", "Money"),
        *("--unit", "EUR", "--limit", "5", "--custom", "owner=ada"),
    )

    assert result.exit_code == 0, result.stderr
    assert dict(seen[0].url.params) == {
        "query": "net revenue",
        "kinds": "metric,term",
        "trust_states": "human_verified,agent_verified",
        "workspace": "Sales",
        "app": "Sales app",
        "dataset": "Sales model",
        "category": "Money",
        "unit": "EUR",
        "limit": "5",
        "custom.owner": "ada",
    }
    assert "net_revenue" in result.stdout
    assert "human_verified" in result.stdout
    assert "Words only." in result.stdout


def test_search_json_is_the_apis_document(serve: Serve) -> None:
    answer = {"items": [HIT], "search_mode": "hybrid", "note": None}
    serve(lambda request: json_response(200, answer))

    result = run("search", "net", "--json")

    assert json.loads(result.stdout) == answer


@pytest.mark.parametrize(
    ("arguments", "route", "answer", "shown"),
    [
        (["workspaces", "list"], "/api/v1/workspaces", [WORKSPACE], "Sales"),
        (["apps", "list"], "/api/v1/apps", [APP], "Sales model, Returns"),
    ],
)
def test_workspaces_and_apps_list_print_a_table_and_json_is_the_array(
    serve: Serve, arguments: list[str], route: str, answer: object, shown: str
) -> None:
    seen = serve(lambda request: json_response(200, answer))

    human = run(*arguments)
    machine = run(*arguments, "--json")

    assert human.exit_code == 0, human.stderr
    assert shown in human.stdout
    assert json.loads(machine.stdout) == answer
    assert seen[0].url.path == route


def test_a_refused_list_exits_4_with_the_apis_sentence(serve: Serve) -> None:
    serve(lambda request: api_error(403, "refused", "You may not list workspaces."))

    result = run("workspaces", "list")

    assert result.exit_code == 4
    assert "You may not list workspaces." in result.stderr


def test_datasets_list_filters_and_points_to_the_next_page(serve: Serve) -> None:
    answer = {"items": [DATASET], "next_cursor": "abc"}
    seen = serve(lambda request: json_response(200, answer))

    result = run(
        *("datasets", "list", "--workspace", "Sales", "--app", "x", "--limit", "1")
    )

    assert result.exit_code == 0, result.stderr
    assert dict(seen[0].url.params) == {"workspace": "Sales", "app": "x", "limit": "1"}
    assert "Sales model" in result.stdout
    assert "--cursor abc" in result.stdout
    assert json.loads(run("datasets", "list", "--json").stdout) == answer


def test_datasets_show_by_id_prints_fields_tables_and_strips_control_characters(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, DETAIL))

    result = run("datasets", "show", DATASET_ID)

    assert result.exit_code == 0, result.stderr
    assert [request.url.path for request in seen] == [f"/api/v1/datasets/{DATASET_ID}"]
    assert "Certified" in result.stdout
    assert "Orders" in result.stdout
    assert "Sales app" in result.stdout
    assert "\x1b" not in result.stdout
    assert json.loads(run("datasets", "show", DATASET_ID, "--json").stdout) == DETAIL


def test_datasets_show_by_name_looks_it_up_and_reads_the_id_the_api_sent(
    serve: Serve,
) -> None:
    others = {**DATASET, "id": OTHER_ID, "name": "Sales model 2"}
    seen = serve(
        lambda request: (
            json_response(200, {"items": [others, DATASET], "next_cursor": None})
            if request.url.path == "/api/v1/datasets"
            else json_response(200, DETAIL)
        )
    )

    result = run("datasets", "show", "Sales model")

    assert result.exit_code == 0, result.stderr
    assert dict(seen[0].url.params) == {"name_prefix": "Sales model", "limit": "500"}
    assert seen[1].url.path == f"/api/v1/datasets/{DATASET_ID}"


def test_datasets_show_a_name_nobody_has_exits_4(serve: Serve) -> None:
    serve(lambda request: json_response(200, {"items": [], "next_cursor": None}))

    result = run("datasets", "show", "Nope")

    assert result.exit_code == 4
    assert "No dataset named Nope" in result.stderr


def test_datasets_show_two_datasets_with_one_name_asks_for_an_id(serve: Serve) -> None:
    twin = {**DATASET, "id": OTHER_ID}
    serve(
        lambda request: json_response(
            200, {"items": [DATASET, twin], "next_cursor": None}
        )
    )

    result = run("datasets", "show", "Sales model")

    assert result.exit_code == 2
    assert DATASET_ID in result.stderr
    assert OTHER_ID in result.stderr


def test_columns_and_measures_list_send_their_filters(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(
            200,
            {
                "items": [MEASURE if "measures" in request.url.path else COLUMN],
                "next_cursor": None,
            },
        )
    )

    columns = run("columns", "list", DATASET_ID, "--table", "Customers")
    measures = run("measures", "list", DATASET_ID, "--table", "Orders", "--unfiled")

    assert "Country" in columns.stdout
    assert "Customers" in columns.stdout
    assert "Net revenue" in measures.stdout
    assert seen[0].url.path == f"/api/v1/datasets/{DATASET_ID}/columns"
    assert dict(seen[0].url.params) == {"table": "Customers"}
    assert seen[1].url.path == f"/api/v1/datasets/{DATASET_ID}/measures"
    assert dict(seen[1].url.params) == {"table": "Orders", "unfiled": "true"}


def test_columns_json_is_the_apis_document(serve: Serve) -> None:
    answer = {"items": [COLUMN], "next_cursor": None}
    serve(lambda request: json_response(200, answer))

    assert json.loads(run("columns", "list", DATASET_ID, "--json").stdout) == answer


@pytest.mark.parametrize("command", ["columns", "measures"])
@pytest.mark.parametrize("typed", ["../../admin/x#y?z", f"{DATASET_ID}/../admin"])
def test_a_typed_dataset_name_goes_in_the_query_never_in_the_path(
    serve: Serve, command: str, typed: str
) -> None:
    seen = serve(lambda request: json_response(200, {"items": [], "next_cursor": None}))

    result = run(command, "list", typed)

    assert result.exit_code == 4
    assert [request.url.raw_path.split(b"?")[0] for request in seen] == [
        b"/api/v1/datasets"
    ]
    assert dict(seen[0].url.params)["name_prefix"] == typed


@pytest.mark.parametrize("command", ["columns", "measures"])
def test_a_dataset_id_from_the_api_stays_under_datasets(
    serve: Serve, command: str
) -> None:
    hostile = {**DATASET, "id": "a/../b#c"}
    seen = serve(
        lambda request: json_response(
            200,
            {"items": [hostile] if request.url.path.endswith("/datasets") else []},
        )
    )

    run(command, "list", "Sales model")

    assert seen[1].url.raw_path == f"/api/v1/datasets/a%2F..%2Fb%23c/{command}".encode()


def test_a_dataset_that_is_not_found_exits_4(serve: Serve) -> None:
    serve(lambda request: api_error(404, "not_found", "No such dataset."))

    result = run("columns", "list", DATASET_ID)

    assert result.exit_code == 4
    assert "No such dataset." in result.stderr


def test_a_name_lookup_stops_when_the_api_repeats_a_cursor(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(200, {"items": [], "next_cursor": "same"})
    )

    result = run("columns", "list", "Nope")

    assert result.exit_code == 1
    assert "did not come to an end" in result.stderr
    assert len(seen) == 2


@pytest.mark.parametrize(
    "arguments",
    [
        ["datasets", "list"],
        ["columns", "list", DATASET_ID],
        ["measures", "list", DATASET_ID],
    ],
)
def test_lists_send_limit_and_cursor_and_point_to_the_next_page(
    serve: Serve, arguments: list[str]
) -> None:
    seen = serve(lambda request: json_response(200, {"items": [], "next_cursor": "c2"}))

    result = run(*arguments, "--limit", "2", "--cursor", "c1")

    assert result.exit_code == 0, result.stderr
    assert dict(seen[0].url.params) == {"limit": "2", "cursor": "c1"}
    assert "--cursor c2" in result.stdout


def test_docs_show_prints_the_description(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, DOCS))

    result = run("docs", "show", "column", DATASET_ID)

    assert result.exit_code == 0, result.stderr
    assert "Where it ships." in result.stdout
    assert seen[0].url.path == f"/api/v1/elements/column/{DATASET_ID}/docs"
    document = json.loads(run("docs", "show", "column", DATASET_ID, "--json").stdout)
    assert document == DOCS


def test_docs_set_sends_the_text_or_the_file_and_nothing_else(
    serve: Serve, tmp_path: Path
) -> None:
    seen = serve(lambda request: json_response(200, DOCS))
    note = tmp_path / "note.md"
    note.write_text("From a file.\n")

    run("docs", "set", "column", DATASET_ID, "--description", "Typed.")
    run("docs", "set", "column", DATASET_ID, "--file", str(note))

    assert [(r.method, json.loads(r.content)) for r in seen] == [
        ("PUT", {"description": "Typed."}),
        ("PUT", {"description": "From a file.\n"}),
    ]


def test_docs_set_needs_exactly_one_source(serve: Serve, tmp_path: Path) -> None:
    seen = serve(lambda request: json_response(200, DOCS))
    note = tmp_path / "note.md"
    note.write_text("x")

    neither = run("docs", "set", "column", DATASET_ID)
    both = run(
        *("docs", "set", "column", DATASET_ID, "--description", "x"),
        *("--file", str(note)),
    )

    assert (neither.exit_code, both.exit_code) == (2, 2)
    assert seen == []


def test_docs_set_a_refused_write_exits_4(serve: Serve) -> None:
    serve(lambda request: api_error(403, "refused", "You may not describe this."))

    result = run("docs", "set", "column", DATASET_ID, "--description", "x")

    assert result.exit_code == 4
    assert "You may not describe this." in result.stderr


@pytest.mark.parametrize(
    "arguments",
    [
        ["login"],
        ["logout"],
        ["search"],
        ["workspaces", "list"],
        ["apps", "list"],
        ["datasets", "list"],
        ["datasets", "show"],
        ["columns", "list"],
        ["measures", "list"],
        ["docs", "show"],
        ["docs", "set"],
        ["terms", "relate"],
        ["terms", "unrelate"],
    ],
)
def test_every_command_helps_with_an_example(arguments: list[str]) -> None:
    assert "Example:" in run(*arguments, "--help").stdout


def test_an_http_deployment_is_refused_before_any_request_is_sent(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, waits: list[float]
) -> None:
    seen = serve(lambda request: json_response(200, []))
    monkeypatch.setenv("PBMB_URL", "http://book.example.test")

    listed = run("workspaces", "list")
    signed_in = run("login", "--url", "http://book.example.test")

    assert (listed.exit_code, signed_in.exit_code) == (2, 2)
    assert "unencrypted" in listed.stderr
    assert seen == []


def test_an_http_deployment_on_localhost_is_allowed(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    seen = serve(lambda request: json_response(200, []))
    monkeypatch.setenv("PBMB_URL", "http://localhost:3000")

    result = run("workspaces", "list")

    assert result.exit_code == 0, result.stderr
    assert str(seen[0].url) == "http://localhost:3000/api/v1/workspaces"


@pytest.mark.parametrize(
    ("address", "allowed"),
    [
        ("https://book.example.test", True),
        ("http://localhost", True),
        ("http://book.localhost:8080", False),
        ("http://127.0.0.2:3000", True),
        ("http://[::1]:3000", True),
        ("http://localhost.example.test", False),
        ("http://127.example.test", False),
        ("http://10.0.0.5", False),
        ("ftp://localhost", False),
        ("https://", False),
    ],
)
def test_only_https_or_loopback_http_may_receive_a_login(
    address: str, allowed: bool
) -> None:
    if allowed:
        require_secure_url(address)
    else:
        with pytest.raises(typer.BadParameter):
            require_secure_url(address)


def test_a_discovered_endpoint_on_another_port_is_refused(
    serve: Serve, waits: list[float]
) -> None:
    seen = serve(sign_in_server([], endpoints={"token_endpoint": f"{URL}:8443/token"}))

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert len(seen) == 1


@pytest.mark.parametrize(
    "interval", ["NaN", "Infinity", "-5", "0", "true", '"5"', "1e999999"]
)
def test_login_refuses_an_interval_that_is_not_a_positive_number(
    serve: Serve, waits: list[float], interval: str
) -> None:
    seen = serve(sign_in_server([], device={"interval": json.loads(interval)}))

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert "not a positive number" in result.stderr
    assert len(seen) == 2
    assert waits == []


def test_login_keeps_the_waits_and_lifetimes_inside_bounds(
    serve: Serve, waits: list[float]
) -> None:
    serve(
        sign_in_server(
            [
                oauth_error("slow_down"),
                json_response(200, {**TOKENS, "expires_in": 10**12}),
            ],
            device={"interval": 10**9, "expires_in": 10**12},
        )
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 0, result.stderr
    assert waits == [60, 60]
    saved = credentials.load()
    assert saved is not None
    assert saved.expires_at - datetime.now(UTC) <= timedelta(days=1)


def test_login_raises_a_too_small_interval_to_five_seconds(
    serve: Serve, waits: list[float]
) -> None:
    serve(sign_in_server([json_response(200, TOKENS)], device={"interval": 0.01}))

    run("login", "--url", URL)

    assert waits == [5]


def test_login_says_when_the_login_cannot_be_written(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, serve: Serve, waits: list[float]
) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a folder")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(blocker))
    serve(sign_in_server([json_response(200, TOKENS)]))

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert "Cannot save your login" in result.stderr
    assert "access-secret-1" not in result.stderr


def test_a_saved_login_never_shows_its_tokens_in_a_traceback_or_a_repr() -> None:
    assert "saved-access" not in repr(a_login())
    assert "saved-refresh" not in repr(a_login())
    assert app.pretty_exceptions_show_locals is False


def test_login_without_a_url_and_with_an_unreadable_login_asks_for_a_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PBMB_URL")
    credentials.save(a_login())
    credentials.credentials_path().chmod(0o644)

    result = run("login")

    assert result.exit_code == 2
    assert "Pass --url" in result.stderr
    assert "cannot be read" in result.stderr


def test_login_to_another_deployment_revokes_the_earlier_login_first(
    serve: Serve, waits: list[float]
) -> None:
    old = "https://old.sample-data.test"
    credentials.save(a_login(url=old, token_endpoint=f"{old}/token"))
    grants = {"grants": [{"id": "g1", "client_id": "pbmb-cli", "via": "cli"}]}
    signing_in = sign_in_server([json_response(200, TOKENS)])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host != "old.sample-data.test":
            return signing_in(request)
        if request.method == "GET":
            return json_response(200, grants)
        return httpx.Response(204)

    seen = serve(handler)

    result = run("login", "--url", URL)

    assert result.exit_code == 0, result.stderr
    assert [(r.method, r.url.path) for r in seen if r.url.host.startswith("old")] == [
        ("GET", "/api/v1/me/grants"),
        ("DELETE", "/api/v1/me/grants/g1"),
    ]
    assert "not revoked" not in result.stderr
    saved = credentials.load()
    assert saved is not None
    assert saved.url == URL


def test_login_says_when_the_earlier_login_could_not_be_revoked(
    serve: Serve, waits: list[float]
) -> None:
    old = "https://old.sample-data.test"
    credentials.save(a_login(url=old, token_endpoint=f"{old}/token"))
    signing_in = sign_in_server([json_response(200, TOKENS)])
    serve(
        lambda request: (
            api_error(500, "internal", "Down for now.")
            if request.url.host == "old.sample-data.test"
            else signing_in(request)
        )
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 0, result.stderr
    assert (
        "earlier login to https://old.sample-data.test was not revoked" in result.stderr
    )
    assert "Down for now." in result.stderr
    assert f"{old}/settings/connections" in result.stderr


def test_logout_deletes_the_login_and_says_so_when_the_revoke_failed(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login())
    serve(lambda request: api_error(503, "unavailable", "Try later."))

    result = run("logout")

    assert result.exit_code == 1
    assert (
        f"Deleted the saved login here, but {URL} did not revoke it: Try later. "
        f"Revoke it at {URL}/settings/connections." in result.stderr
    )
    assert credentials.load() is None


def test_logout_of_a_login_the_deployment_already_refuses_succeeds(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(hours=1)))
    serve(lambda request: api_error(400, "invalid_grant", "Revoked."))

    result = run("logout", "--json")

    assert result.exit_code == 0, result.stderr
    assert json.loads(result.stdout) == {"signed_out": True, "revoked_grants": 0}
    assert credentials.load() is None


def test_a_file_a_command_sends_must_be_small_utf8_text(
    serve: Serve, tmp_path: Path
) -> None:
    seen = serve(lambda request: json_response(200, DOCS))
    binary = tmp_path / "picture.png"
    binary.write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe")
    large = tmp_path / "large.txt"
    large.write_text("x" * (1024 * 1024 + 1))

    for name, path, sentence in (
        ("binary", binary, "not UTF-8 text"),
        ("large", large, "larger than"),
        ("missing", tmp_path / "gone", "Cannot open"),
        ("directory", tmp_path, "not a regular file"),
        ("zeros", Path("/dev/zero"), "not a regular file"),
    ):
        for command in (
            ["docs", "set", "column", DATASET_ID, "--file", str(path)],
            ["dax", "run", "ds_1", "--file", str(path)],
        ):
            result = run(*command)
            assert result.exit_code == 2, (name, command)
            assert sentence in result.stderr, (name, command)
    assert seen == []


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs named pipes")
def test_a_named_pipe_is_refused_without_waiting_for_a_writer(
    serve: Serve, tmp_path: Path
) -> None:
    seen = serve(lambda request: json_response(200, DOCS))
    pipe = tmp_path / "pipe"
    os.mkfifo(pipe)

    result = run("docs", "set", "column", DATASET_ID, "--file", str(pipe))

    assert result.exit_code == 2
    assert "not a regular file" in result.stderr
    assert seen == []


def test_the_saved_login_is_never_sent_as_a_description(
    serve: Serve, tmp_path: Path
) -> None:
    seen = serve(lambda request: json_response(200, DOCS))
    credentials.save(a_login())
    link = tmp_path / "innocent.txt"
    link.symlink_to(credentials.credentials_path())

    for path, refusal in (
        (credentials.credentials_path(), "Not sending your saved login"),
        (link, "is a symbolic link"),
    ):
        result = run("dax", "run", "ds_1", "--file", str(path))
        assert result.exit_code == 2
        assert refusal in result.stderr
    assert "saved-access" not in result.stderr
    assert seen == []


def test_a_user_code_cannot_start_a_line_of_its_own(
    serve: Serve, waits: list[float]
) -> None:
    serve(
        sign_in_server(
            [json_response(200, TOKENS)],
            device={"user_code": "ABCD\nSigned in to https://evil.test." + BIDI},
        )
    )

    result = run("login", "--url", URL)

    assert "ABCD Signed in to https://evil.test." in result.stderr
    assert "\nSigned in to" not in result.stderr
    assert BIDI not in result.stderr


def test_workspace_names_in_the_ambiguous_name_error_stay_on_one_line(
    serve: Serve,
) -> None:
    lying = {**SALES, "name": "Sales\nUse this id instead"}
    twins = [{**DATASET, "workspace": lying}, {**DATASET, "id": OTHER_ID}]
    serve(lambda request: json_response(200, {"items": twins, "next_cursor": None}))

    result = run("columns", "list", "Sales model")

    assert result.exit_code == 2
    assert "workspace Sales Use this id instead" in " ".join(result.stderr.split())


def test_login_refuses_a_document_whose_issuer_is_not_the_deployments(
    serve: Serve, waits: list[float]
) -> None:
    seen = serve(
        sign_in_server([], endpoints={"issuer": "https://elsewhere.test/api/auth"})
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert "elsewhere.test" in result.stderr
    assert len(seen) == 1


def test_login_refuses_a_device_endpoint_on_another_host(
    serve: Serve, waits: list[float]
) -> None:
    seen = serve(
        sign_in_server(
            [], endpoints={"device_authorization_endpoint": "https://evil.test/code"}
        )
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert [request.url.host for request in seen] == ["book.sample-data.test"]


def test_login_refuses_a_page_to_open_that_holds_a_backslash(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, waits: list[float]
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    seen = serve(sign_in_server([], device={"verification_uri": f"{URL}/device\\"}))

    result = run("login", "--url", URL, "--open")

    assert result.exit_code == 1
    assert "Not opening it" in result.stderr
    assert opened == []
    assert credentials.load() is None
    assert len(seen) == 2


def test_a_file_is_still_sent_when_the_login_file_cannot_be_compared(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, serve: Serve
) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a folder")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(blocker))
    note = tmp_path / "note.md"
    note.write_text("Typed in a file.")
    seen = serve(lambda request: json_response(200, DOCS))

    result = run("docs", "set", "column", DATASET_ID, "--file", str(note))

    assert result.exit_code == 0, result.stderr
    assert json.loads(seen[0].content) == {"description": "Typed in a file."}


def test_login_refuses_a_page_to_open_on_another_host(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, waits: list[float]
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    seen = serve(
        sign_in_server([], device={"verification_uri": "https://evil.test/device"})
    )

    result = run("login", "--url", URL, "--open")

    assert result.exit_code == 1
    assert "evil.test" in result.stderr
    assert opened == []
    assert len(seen) == 2


def test_login_stops_waiting_when_the_code_runs_out_though_the_server_says_pending(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    clock = [0.0]

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    monkeypatch.setattr(time, "sleep", sleep)
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])
    seen = serve(
        sign_in_server(
            [oauth_error("authorization_pending")] * 10, device={"expires_in": 12}
        )
    )

    result = run("login", "--url", URL)

    assert result.exit_code == 1
    assert "expired" in result.stderr
    assert len(seen) == 2 + 3
    assert credentials.load() is None


def test_a_field_or_column_name_from_the_api_prints_literally_never_as_markup(
    serve: Serve,
) -> None:
    name = "[link=https://evil.example]x[/link]"
    columns = [{"name": "[b]Net[/b]", "type": "number"}]
    result_answer = {"columns": columns, "preview": [[1]], "row_count": 1}
    serve(
        lambda request: (
            json_response(201, {**result_answer, "result_id": "r"})
            if request.url.path == "/api/v1/queries"
            else json_response(200, {**DOCS, name: "v"})
        )
    )

    fields = run("docs", "show", "column", DATASET_ID)
    rows = run("dax", "run", "ds_1", "--query", "EVALUATE x")

    assert name in fields.stdout
    assert "\x1b]8" not in fields.stdout
    assert "[b]Net[/b]" in rows.stdout


def test_logout_deletes_a_login_it_cannot_read_and_says_where_to_revoke_it(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login())
    credentials.credentials_path().chmod(0o644)
    seen = serve(lambda request: json_response(200, {}))

    result = run("logout")

    assert result.exit_code == 1
    assert f"{URL}/settings/connections" in result.stderr
    assert not credentials.credentials_path().exists()
    assert seen == []


def test_a_name_lookup_stops_after_100_pages(serve: Serve) -> None:
    pages = iter(range(1000))
    seen = serve(
        lambda request: json_response(
            200, {"items": [], "next_cursor": f"c{next(pages)}"}
        )
    )

    result = run("columns", "list", "Nope")

    assert result.exit_code == 1
    assert "did not come to an end" in result.stderr
    assert len(seen) == 100


def test_a_login_file_owned_by_someone_else_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credentials.save(a_login())
    owner = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: owner + 1)

    with pytest.raises(credentials.CredentialsError, match="another user"):
        credentials.load()


def test_a_login_is_synced_to_disk_before_it_replaces_the_old_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    fsync, replace = os.fsync, os.replace
    monkeypatch.setattr(os, "fsync", lambda fd: (calls.append("fsync"), fsync(fd)))
    monkeypatch.setattr(
        os, "replace", lambda a, b: (calls.append("replace"), replace(a, b))
    )

    credentials.save(a_login())

    assert calls == ["fsync", "replace"]


def test_a_refresh_that_lost_the_race_uses_the_winners_login_and_keeps_it(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(hours=1)))

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            credentials.save(
                a_login(access_token="winner-access", refresh_token="winner-refresh")
            )
            return oauth_error("invalid_grant")
        return json_response(200, [])

    seen = serve(handler)

    result = run("workspaces", "list")

    assert result.exit_code == 0, result.stderr
    assert seen[-1].headers["authorization"] == "Bearer winner-access"
    saved = credentials.load()
    assert saved is not None
    assert saved.refresh_token == "winner-refresh"


def refresh_server(lifetime: object) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_ENDPOINT:
            body = json.dumps({**TOKENS, "expires_in": lifetime})
            return httpx.Response(
                200, content=body, headers={"content-type": "application/json"}
            )
        return json_response(200, [])

    return handler


@pytest.mark.parametrize("lifetime", [float("nan"), float("inf"), -1, 0, True])
def test_a_refresh_with_a_lifetime_that_is_not_a_positive_number_keeps_the_login(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, lifetime: object
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(hours=1)))
    serve(refresh_server(lifetime))

    result = run("workspaces", "list")

    assert result.exit_code == 1
    assert "not a positive number" in result.stderr
    saved = credentials.load()
    assert saved is not None
    assert saved.refresh_token == "saved-refresh"


def test_a_refresh_with_a_huge_lifetime_is_capped_at_one_day(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.delenv("PBMB_API_KEY")
    credentials.save(a_login(expires_at=datetime.now(UTC) - timedelta(hours=1)))
    serve(refresh_server(10**12))

    result = run("workspaces", "list")

    assert result.exit_code == 0, result.stderr
    saved = credentials.load()
    assert saved is not None
    assert saved.refresh_token == "refresh-secret-1"
    assert saved.expires_at - datetime.now(UTC) <= timedelta(days=1)
