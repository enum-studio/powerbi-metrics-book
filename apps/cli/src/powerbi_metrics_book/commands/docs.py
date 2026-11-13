from pathlib import Path
from typing import Annotated

import typer

from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import api_path
from powerbi_metrics_book.files import read_text_file
from powerbi_metrics_book.output import JsonOption

app = typer.Typer(
    help="The descriptions you write for datasets, tables, columns and measures.",
    no_args_is_help=True,
)

Kind = Annotated[
    str, typer.Argument(help="What it is: dataset, table, column or measure.")
]
ElementId = Annotated[str, typer.Argument(help="The element's id.")]


@app.command("show")
def show(
    context: typer.Context,
    kind: Kind,
    element_id: ElementId,
    json_output: JsonOption = False,
) -> None:
    """Show an element's description, who wrote it, and its custom fields.

    Example: pbmb docs show column 7c9e6679-7425-40de-944b-e07fc1f90ae7
    """
    show_object(
        context,
        json_output,
        "GET",
        api_path("elements", kind, element_id, "docs"),
        "the description",
    )


@app.command("set")
def set_description(
    context: typer.Context,
    kind: Kind,
    element_id: ElementId,
    description: Annotated[
        str | None, typer.Option(help="The description, as plain text or Markdown.")
    ] = None,
    file: Annotated[
        Path | None,
        typer.Option(help="Read the description from this UTF-8 text file."),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Set an element's description. It replaces the one written before.

    Example: pbmb docs set measure 7c9e6679-7425-40de-944b-e07fc1f90ae7 --file net.md
    """
    if (description is None) == (file is None):
        raise typer.BadParameter("Give exactly one of --description and --file.")
    text = description if file is None else read_text_file(file)
    show_object(
        context,
        json_output,
        "PUT",
        api_path("elements", kind, element_id, "docs"),
        "the description",
        body={"description": text},
    )
