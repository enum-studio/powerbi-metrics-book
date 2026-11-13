from typing import Annotated

import typer

from powerbi_metrics_book.answers import query_of
from powerbi_metrics_book.calls import show_list, show_object
from powerbi_metrics_book.client import api_path
from powerbi_metrics_book.output import JsonOption

app = typer.Typer(help="Search the query log and look at one logged query.")

QUERY_COLUMNS = ["id", "at", "status", "dataset.name", "row_count", "purpose"]


@app.command("search")
def search(
    context: typer.Context,
    words: Annotated[
        str | None, typer.Argument(help="Words to find in the DAX and the purpose.")
    ] = None,
    dataset: Annotated[str | None, typer.Option(help="Only this dataset.")] = None,
    metric: Annotated[
        str | None, typer.Option(help="Only queries that used this metric.")
    ] = None,
    mine: Annotated[bool, typer.Option("--mine", help="Only your own.")] = False,
    status: Annotated[
        str | None, typer.Option(help="succeeded, truncated, failed or refused.")
    ] = None,
    since: Annotated[
        str | None,
        typer.Option(help="Only after this timestamp, such as 2026-10-01T00:00:00Z."),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Search the log of queries, newest first.

    Every signed-in user sees every entry: who ran it, when, the dataset, the
    DAX, the purpose and the row count, never the results. Use it to find DAX
    that already answers your question before you write new DAX.
    """
    show_list(
        context,
        json_output,
        "/queries",
        "items",
        QUERY_COLUMNS,
        "the queries",
        query=query_of(
            text=words,
            dataset=dataset,
            metric=metric,
            mine=True if mine else None,
            status=status,
            since=since,
        ),
    )


@app.command("show")
def show(
    context: typer.Context,
    query_id: Annotated[str, typer.Argument(metavar="ID", help="The query id.")],
    json_output: JsonOption = False,
) -> None:
    """Show one logged query: its DAX, who ran it, how it ended and its result id."""
    show_object(context, json_output, "GET", api_path("queries", query_id), "the query")
