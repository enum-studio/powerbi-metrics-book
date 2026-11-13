from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import object_of, plain, string_field, text_of
from powerbi_metrics_book.client import Json
from powerbi_metrics_book.csv_download import download_csv, show_download
from powerbi_metrics_book.files import read_text_file
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_rows

app = typer.Typer(help="Run DAX against a dataset, under your own Power BI rights.")


@app.command("run")
def run(
    context: typer.Context,
    dataset: Annotated[str, typer.Argument(help="The dataset's id or name.")],
    file: Annotated[
        Path | None,
        typer.Option("--file", help="Read the DAX from a file."),
    ] = None,
    query: Annotated[
        str | None, typer.Option("--query", help="The DAX, as text.")
    ] = None,
    purpose: Annotated[
        str | None, typer.Option(help="Why you run it; kept in the query log.")
    ] = None,
    preview: Annotated[int | None, typer.Option(help="How many rows to print.")] = None,
    csv: Annotated[
        Path | None,
        typer.Option(
            "--csv",
            dir_okay=False,
            help="Download the whole result to this file instead of printing it.",
        ),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Run DAX against a dataset and print a preview of the rows.

    Give the DAX with --file or --query. The query runs with your own Power
    BI token, so you see only what Power BI lets you see. The preview and the
    result id are printed; read more rows with `pbmb results read <id>`.

    With --csv the whole result is downloaded to the file in this one command
    and only the path and the number of rows are printed.
    """
    if file is not None and query is None:
        dax = read_text_file(file)
    elif query is not None and file is None:
        dax = query
    else:
        raise typer.BadParameter("Give the DAX with --file or with --query, not both.")
    body: dict[str, Json] = {"dataset": dataset, "dax": dax, "purpose": purpose}
    if preview is not None:
        body["preview_rows"] = preview
    with open_session(context, json_output) as session:
        answer = object_of(
            session.client.request("POST", "/queries", body=body), "the query"
        )
        result_id = string_field(answer, "result_id")
        if csv is not None:
            show_download(
                session,
                csv,
                download_csv(session, result_id, csv, answered_by_api=True),
            )
        else:
            session.emit(answer, lambda console: _show(console, answer, result_id))


def _show(console: Console, answer: dict[str, Json], result_id: str) -> None:
    print_rows(console, answer, "preview")
    console.print(Text(plain(f"Result {result_id}: {answer.get('row_count')} rows.")))
    for note in ("truncation_note", "preview_note"):
        if answer.get(note):
            console.print(Text(plain(text_of(answer[note]))))
