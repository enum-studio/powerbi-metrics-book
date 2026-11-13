from typing import Annotated

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import dig, object_of, objects_in, query_of
from powerbi_metrics_book.calls import dataset_id, show_object
from powerbi_metrics_book.client import Json, api_path
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_fields, print_table, render_page

app = typer.Typer(help="The Power BI datasets you may describe.", no_args_is_help=True)

COLUMNS = ["id", "name", "workspace.name", "has_row_level_security"]
TABLE_COLUMNS = ["name", "column_count", "measure_count", "description_pbi"]
NOT_SHOWN_AS_FIELDS = {
    "tables",
    "relationships",
    "accepted_answers",
    "apps",
    "reached_through",
    "custom",
    "workspace",
}


def _show(console: Console, dataset: dict[str, Json]) -> None:
    fields = {
        name: value
        for name, value in dataset.items()
        if name not in NOT_SHOWN_AS_FIELDS
    }
    fields["workspace"] = dig(dataset, "workspace.name")
    fields["apps"] = [app.get("name") for app in objects_in(dataset, "apps")]
    print_fields(console, fields)
    console.print(Text("\nTables"))
    print_table(console, objects_in(dataset, "tables"), TABLE_COLUMNS)


@app.command("list")
def list_datasets(
    context: typer.Context,
    workspace: Annotated[
        str | None, typer.Option(help="Only this workspace (id or name).")
    ] = None,
    app_id: Annotated[
        str | None, typer.Option("--app", help="Only this app (id or name).")
    ] = None,
    limit: Annotated[
        int | None, typer.Option(help="At most this many (1 to 500).")
    ] = None,
    cursor: Annotated[
        str | None, typer.Option(help="Continue from the cursor a page ended with.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List the datasets you may describe, A to Z.

    Example: pbmb datasets list --workspace Sales
    """
    show_object(
        context,
        json_output,
        "GET",
        "/datasets",
        "the datasets",
        query=query_of(workspace=workspace, app=app_id, limit=limit, cursor=cursor),
        render=render_page(COLUMNS),
    )


@app.command("show")
def show(
    context: typer.Context,
    dataset: Annotated[
        str,
        typer.Argument(help="The dataset's id or name."),
    ],
    json_output: JsonOption = False,
) -> None:
    """Show a dataset: where it lives, its tables, and what is known about it.

    Example: pbmb datasets show Sales
    """
    with open_session(context, json_output) as session:
        answer = object_of(
            session.client.get(
                api_path(
                    "datasets",
                    dataset_id(session.client, dataset),
                    answered_by_api=True,
                )
            ),
            "the dataset",
        )
        session.emit(answer, lambda console: _show(console, answer))
