from typing import Annotated

import typer

from powerbi_metrics_book.calls import show_list, show_object
from powerbi_metrics_book.output import JsonOption

app = typer.Typer(
    help="Start a sync of the Power BI tenant and see how the last ones went.",
    no_args_is_help=True,
)

RUN_COLUMNS = [
    "id",
    "kind",
    "trigger",
    "status",
    "started_at",
    "finished_at",
    "workspaces_scanned",
    "error",
]


@app.command("run")
def run(
    context: typer.Context,
    full: Annotated[
        bool,
        typer.Option(
            "--full", help="Read every workspace again, not only what changed."
        ),
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Queue a sync now, unless one is already waiting or running.

    The sync reads the tenant's workspaces, datasets and measures. By default
    it reads only what changed since the last one. See how it goes with
    `pbmb sync status`.
    """
    show_object(
        context,
        json_output,
        "POST",
        "/admin/sync",
        "the sync",
        body={"kind": "full" if full else "incremental"},
    )


@app.command("status")
def status(context: typer.Context, json_output: JsonOption = False) -> None:
    """Show the newest sync runs, how each ended and how many workspaces it read."""
    show_list(context, json_output, "/admin/sync", "runs", RUN_COLUMNS, "the runs")
