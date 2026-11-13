from typing import Annotated

import typer

from powerbi_metrics_book.answers import object_of, query_of
from powerbi_metrics_book.calls import dataset_id
from powerbi_metrics_book.client import api_path
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import render_page

app = typer.Typer(help="The columns of a dataset.", no_args_is_help=True)

COLUMNS = [
    "id",
    "table.name",
    "name",
    "data_type",
    "column_type",
    "is_hidden",
    "description",
]


@app.command("list")
def list_columns(
    context: typer.Context,
    dataset: Annotated[
        str,
        typer.Argument(help="The dataset's id or name."),
    ],
    table: Annotated[
        str | None, typer.Option(help="Only this table (id or name).")
    ] = None,
    limit: Annotated[
        int | None, typer.Option(help="At most this many (1 to 500).")
    ] = None,
    cursor: Annotated[
        str | None, typer.Option(help="Continue from the cursor a page ended with.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List a dataset's columns, A to Z, with their descriptions.

    Example: pbmb columns list 7c9e6679-7425-40de-944b-e07fc1f90ae7 --table Sales
    """
    with open_session(context, json_output) as session:
        route = api_path(
            "datasets",
            dataset_id(session.client, dataset),
            "columns",
            answered_by_api=True,
        )
        answer = object_of(
            session.client.get(
                route,
                query_of(table=table, limit=limit, cursor=cursor),
            ),
            "the columns",
        )
        session.emit(answer, lambda console: render_page(COLUMNS)(console, answer))
