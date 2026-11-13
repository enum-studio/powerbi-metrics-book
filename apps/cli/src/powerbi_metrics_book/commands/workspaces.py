import typer

from powerbi_metrics_book.answers import objects_of
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_table

app = typer.Typer(help="The Power BI workspaces you can see.", no_args_is_help=True)

COLUMNS = ["id", "name", "dataset_count"]


@app.command("list")
def list_workspaces(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the workspaces you can see, with how many datasets each holds.

    Example: pbmb workspaces list
    """
    with open_session(context, json_output) as session:
        answer = session.client.get("/workspaces")
        rows = objects_of(answer, "workspaces")
        session.emit(answer, lambda console: print_table(console, rows, COLUMNS))
