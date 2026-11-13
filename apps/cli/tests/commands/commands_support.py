"""Helpers the command tests share (see cli_support.py for why this is not
in conftest)."""

import json
from collections.abc import Iterator

import httpx
from cli_support import URL, json_response
from typer.testing import CliRunner, Result

from powerbi_metrics_book.cli import app
from powerbi_metrics_book.client import Json

SIGNATURE = "sig-9f8e7d"
CSV_URL = (
    f"{URL}/api/v1/results/res_1/csv?expires=2026-10-26T12:00:00Z&signature={SIGNATURE}"
)
RESULT = {
    "result_id": "res_1",
    "query_id": "qry_1",
    "dataset": {"id": "ds_1", "name": "Sales"},
    "columns": [
        {"name": "Country", "type": "string"},
        {"name": "Net", "type": "number"},
    ],
    "row_count": 2,
    "bytes": 40,
    "truncated": False,
    "truncation_note": None,
    "preview": [["Denmark", 10], ["Norway", 7]],
    "preview_note": None,
    "next_offset": None,
    "csv_url": CSV_URL,
    "csv_url_expires_at": "2026-10-26T12:00:00Z",
    "expires_at": "2026-11-02T12:00:00Z",
}


def run(*arguments: str, input: str | None = None) -> Result:
    return CliRunner().invoke(app, list(arguments), input=input)


def sent(request: httpx.Request) -> dict[str, Json]:
    body: dict[str, Json] = json.loads(request.content)
    return body


def csv_handler(request: httpx.Request, link: str = CSV_URL) -> httpx.Response:
    if request.url.path == "/api/v1/queries":
        return json_response(201, RESULT)
    if request.url.path == "/api/v1/results/res_1/csv-link":
        return json_response(
            200, {"csv_url": link, "csv_url_expires_at": "2026-10-26T12:00:00Z"}
        )

    def chunks() -> Iterator[bytes]:
        yield b"Country,Net\nDenmark,10\n"
        yield b'"Nor\nway",7\n'

    return httpx.Response(200, content=chunks())
