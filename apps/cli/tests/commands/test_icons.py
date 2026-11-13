import json

import httpx
import pytest
from cli_support import Serve, api_error, json_response
from commands_support import run, sent

from powerbi_metrics_book.client import Client

ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
PATH = f"/api/v1/elements/category/{ID}/icon"


def test_set_category_resolves_path_and_sends_glyph(serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.path == "/api/v1/categories"
            return json_response(
                200,
                [
                    {
                        "id": "root",
                        "path": "sales",
                        "children": [
                            {"id": ID, "path": "sales/retail", "children": []}
                        ],
                    }
                ],
            )
        assert request.method == "PUT"
        assert request.url.path == PATH
        assert sent(request) == {"icon": "glyph:chart-line:green"}
        return json_response(
            200, {"kind": "category", "id": ID, "icon": "glyph:chart-line:green"}
        )

    requests = serve(handler)
    result = run("icons", "set", "category", "sales/retail", "chart-line:green")
    assert result.exit_code == 0, result.output
    assert len(requests) == 2


@pytest.mark.parametrize(
    ("kind", "reference", "value", "wire"),
    [
        ("metric", "net_sales", "📈", "emoji:📈"),
        ("term", "Active customer", "users", "glyph:users:gray"),
        ("dataset", "Retail Sales", "glyph:store:blue", "glyph:store:blue"),
        ("workspace", "Sales", "emoji:📈", "emoji:📈"),
        ("workspace", ID, "store", "glyph:store:gray"),
        ("dataset", ID, "store", "glyph:store:gray"),
    ],
)
def test_set_forms_and_references(
    serve: Serve, kind: str, reference: str, value: str, wire: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            if kind in ("metric", "term"):
                assert request.url.path == f"/api/v1/{kind}s/{reference}"
                return json_response(200, {"id": ID})
            assert request.url.path == f"/api/v1/{kind}s"
            items = [{"id": ID, "name": reference}]
            return json_response(
                200,
                {"items": items, "next_cursor": None} if kind == "dataset" else items,
            )
        assert request.url.path == f"/api/v1/elements/{kind}/{ID}/icon"
        assert sent(request) == {"icon": wire}
        return json_response(200, {"kind": kind, "id": ID, "icon": wire})

    serve(handler)
    result = run("icons", "set", kind, reference, value, "--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"kind": kind, "id": ID, "icon": wire}


@pytest.mark.parametrize("json_output", [False, True])
def test_clear(serve: Serve, json_output: bool) -> None:
    answer = {"kind": "term", "id": "api-returned-id", "icon": None}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.path == "/api/v1/terms/Active customer"
            return json_response(200, {"id": ID})
        assert request.method == "DELETE"
        assert request.url.path == f"/api/v1/elements/term/{ID}/icon"
        return json_response(200, answer)

    serve(handler)
    result = run(
        "icons",
        "clear",
        "term",
        "Active customer",
        *(["--json"] if json_output else []),
    )
    assert result.exit_code == 0, result.output
    if json_output:
        assert json.loads(result.stdout) == answer
    else:
        assert "api-returned-id" in result.stdout


@pytest.mark.parametrize("json_output", [False, True])
def test_list_filters_glyphs_and_keeps_colors(serve: Serve, json_output: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/icons"
        return json_response(
            200, {"glyphs": ["chart-line", "store"], "colors": ["gray", "green"]}
        )

    serve(handler)
    result = run(
        "icons", "list", "--search", "chart", *(["--json"] if json_output else [])
    )
    assert result.exit_code == 0, result.output
    assert "store" not in result.stdout
    if json_output:
        assert json.loads(result.stdout) == {
            "glyphs": ["chart-line"],
            "colors": ["gray", "green"],
        }
    else:
        assert all(word in result.stdout for word in ["chart-line", "gray", "green"])


@pytest.mark.parametrize("kind", ["category", "workspace", "dataset"])
@pytest.mark.parametrize("ambiguous", [False, True])
def test_refusal_without_writing(serve: Serve, kind: str, ambiguous: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        items = (
            [
                {
                    "id": identifier,
                    "name": "Sales",
                    "path": "Sales",
                    "children": [],
                    "workspace": {"name": "Retail"},
                }
                for identifier in [ID, "another-id"]
            ]
            if ambiguous
            else []
        )
        return json_response(
            200, {"items": items, "next_cursor": None} if kind == "dataset" else items
        )

    serve(handler)
    result = run("icons", "set", kind, "Sales", "store")
    assert result.exit_code == (2 if ambiguous else 4)
    assert (ID if ambiguous else "No ") in result.output
    if ambiguous:
        assert "another-id" in result.output


def test_api_refusal_is_printed(serve: Serve) -> None:
    serve(
        lambda request: api_error(400, "refused", "Choose a glyph from the icon list.")
    )
    result = run("icons", "set", "dataset", ID, "unknown:green")
    assert result.exit_code == 4
    assert result.stderr.strip() == "Choose a glyph from the icon list."


@pytest.mark.parametrize("glyphs", [None, "chart-line", {}])
def test_list_refuses_glyphs_that_are_not_a_list(serve: Serve, glyphs: object) -> None:
    serve(lambda request: json_response(200, {"glyphs": glyphs, "colors": ["gray"]}))
    result = run("icons", "list", "--search", "chart", "--json")
    assert result.exit_code == 1
    assert result.stderr.strip() == "The api did not answer a list of glyphs."
    assert result.stdout == ""


@pytest.mark.parametrize("command", ["set", "clear"])
def test_resolve_and_write_share_a_session(
    serve: Serve, monkeypatch: pytest.MonkeyPatch, command: str
) -> None:
    closed: list[Client] = []
    original_close = Client.close

    def close(client: Client) -> None:
        closed.append(client)
        original_close(client)

    def handler(request: httpx.Request) -> httpx.Response:
        assert not closed
        return json_response(200, {"kind": "term", "id": ID, "icon": None})

    serve(handler)
    monkeypatch.setattr(Client, "close", close)
    result = run(
        "icons",
        command,
        "term",
        "Active customer",
        *(["store"] if command == "set" else []),
    )
    assert result.exit_code == 0, result.output
    assert len(closed) == 1
