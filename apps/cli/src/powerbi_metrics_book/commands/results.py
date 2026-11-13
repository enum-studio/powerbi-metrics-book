from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import plain, query_of, text_of
from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import Json, api_path
from powerbi_metrics_book.csv_download import download_csv, show_download
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_rows

app = typer.Typer(help="Read the rows of a query result, or download them as CSV.")

ResultId = Annotated[str, typer.Argument(metavar="ID", help="The result id.")]


@app.command("read")
def read(
    context: typer.Context,
    result_id: ResultId,
    offset: Annotated[int | None, typer.Option(help="Rows to skip.")] = None,
    limit: Annotated[int | None, typer.Option(help="Rows to read.")] = None,
    json_output: JsonOption = False,
) -> None:
    """Read rows of a result you ran, a page at a time.

    A result is readable only by the person or service account that ran its
    query. Results expire; the answer says when. A page that is not the last
    names the offset to ask for next.
    """

    def render(console: Console, page: dict[str, Json]) -> None:
        print_rows(console, page, "rows")
        console.print(Text(plain(f"{page.get('row_count')} rows in the result.")))
        if page.get("note"):
            console.print(Text(plain(text_of(page["note"]))))
        more = page.get("next_offset")
        if more is not None:
            console.print(
                Text(plain(f"More: pbmb results read {result_id} --offset {more}"))
            )

    show_object(
        context,
        json_output,
        "GET",
        api_path("results", result_id),
        "the result",
        query=query_of(offset=offset, limit=limit),
        render=render,
    )


@app.command("csv")
def csv_command(
    context: typer.Context,
    result_id: ResultId,
    output: Annotated[
        Path, typer.Option("-o", "--output", dir_okay=False, help="The file to write.")
    ],
    json_output: JsonOption = False,
) -> None:
    """Download a result you ran as a CSV file.

    Asks for a signed link that works for 15 minutes and downloads from it to
    the file, which is written whole or not at all and readable by you only.
    Prints the path and the number of rows.
    """
    with open_session(context, json_output) as session:
        show_download(session, output, download_csv(session, result_id, output))
