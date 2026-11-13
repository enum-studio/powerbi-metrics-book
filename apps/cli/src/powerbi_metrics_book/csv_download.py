"""Downloading a result as CSV from its signed link.

The link is the credential, so the download carries none of ours, is made only
to the api's own address, follows no redirect, and no sentence here repeats
the link or its signature.
"""

import csv
import os
import tempfile
from pathlib import Path

import httpx
import typer

from powerbi_metrics_book.answers import object_of, plain, string_field
from powerbi_metrics_book.client import (
    TIMEOUT_SECONDS,
    ApiError,
    UnreachableError,
    api_path,
)
from powerbi_metrics_book.output import FAILED, Session


def download_csv(
    session: Session, result_id: str, path: Path, *, answered_by_api: bool = False
) -> int:
    """Asks for a signed link and streams the CSV to path; returns its rows.

    The file is written whole or not at all, readable by you only. Raises
    ApiError or UnreachableError with a one-sentence message.
    """
    link = object_of(
        session.client.request(
            "POST",
            api_path("results", result_id, "csv-link", answered_by_api=answered_by_api),
        ),
        "a CSV link",
    )
    url = _own_address(session.client.url, string_field(link, "csv_url"))
    try:
        with (
            httpx.Client(
                base_url=session.client.url, timeout=TIMEOUT_SECONDS
            ) as download,
            download.stream("GET", url) as response,
        ):
            if not response.is_success:
                raise _refused(response.status_code)
            rows = _save(response, path)
    except httpx.TransportError as error:
        raise UnreachableError(
            f"Cannot download the CSV from {httpx.URL(url).host}."
        ) from error
    except httpx.DecodingError as error:
        raise ApiError(
            "upstream", "The CSV download could not be decoded.", 200
        ) from error
    except OSError as error:
        typer.echo(plain(f"Cannot write {path}: {error.strerror}."), err=True)
        raise typer.Exit(FAILED) from error
    return rows


def show_download(session: Session, path: Path, row_count: int) -> None:
    session.emit(
        {"path": str(path), "row_count": row_count},
        lambda _console: typer.echo(plain(f"{path}: {row_count} rows")),
    )


def _own_address(api_url: str, link: str) -> str:
    """The link as a full URL, which must be on the api's scheme, host and port."""
    try:
        base = httpx.URL(api_url)
        target = base.join(link)
    except httpx.InvalidURL as error:
        raise ApiError(
            "upstream", "The api answered a CSV link that is not a URL.", 200
        ) from error
    if (target.scheme, target.host, target.port) != (base.scheme, base.host, base.port):
        raise ApiError(
            "upstream",
            "The api answered a CSV link on another address than its own, so "
            "nothing was downloaded.",
            200,
        )
    return str(target)


def _refused(status: int) -> ApiError:
    if status == 429:
        return ApiError(
            "rate_limited",
            "Too many downloads. Wait a minute and run it again.",
            status,
        )
    if status in (401, 403, 404):
        return ApiError(
            "refused",
            "The download link was refused or has expired. Run the command again "
            "for a new one.",
            status,
        )
    return ApiError(
        "upstream",
        f"The CSV download answered {status}. Run the command again for a new link.",
        status,
    )


def _save(response: httpx.Response, path: Path) -> int:
    """Writes the body beside path, checks it is a UTF-8 CSV, and only then
    replaces path. Returns the rows after the header."""
    # mkstemp creates the file exclusively with mode 0600, so a planted file or
    # link at that name cannot be written through, and nobody else reads it.
    descriptor, name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".part"
    )
    partial = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            for chunk in response.iter_bytes():
                file.write(chunk)
        rows = _count_rows(partial)
        partial.replace(path)
        return rows
    finally:
        partial.unlink(missing_ok=True)


def _count_rows(path: Path) -> int:
    try:
        with path.open(newline="", encoding="utf-8-sig") as file:
            return max(sum(1 for _ in csv.reader(file)) - 1, 0)
    except (UnicodeDecodeError, csv.Error) as error:
        raise ApiError(
            "upstream",
            "The download was not a UTF-8 CSV file, so it was not kept.",
            200,
        ) from error
