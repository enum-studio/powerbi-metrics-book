import typer

from powerbi_metrics_book.answers import objects_in, objects_of
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_table

app = typer.Typer(help="The Power BI apps you can see.", no_args_is_help=True)

COLUMNS = ["id", "name", "workspace.name", "datasets"]


@app.command("list")
def list_apps(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the apps you can see, with the datasets behind each.

    Example: pbmb apps list
    """
    with open_session(context, json_output) as session:
        answer = session.client.get("/apps")
        rows = [
            {
                **row,
                "datasets": [
                    dataset.get("name") for dataset in objects_in(row, "datasets")
                ],
            }
            for row in objects_of(answer, "apps")
        ]
        session.emit(answer, lambda console: print_table(console, rows, COLUMNS))
