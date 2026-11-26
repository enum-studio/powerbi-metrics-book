import typer

from powerbi_metrics_book.answers import object_of, string_field
from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.output import JsonOption
from powerbi_metrics_book.tables import line

app = typer.Typer(help="Read or export the curated guide to the metrics book.")


@app.command("show")
def show(context: typer.Context, json_output: JsonOption = False) -> None:
    """Read the guide as Markdown, with only the metrics you may see."""
    show_object(
        context,
        json_output,
        "GET",
        "/guide/export",
        "the guide",
        render=lambda console, value: line(
            console, string_field(object_of(value, "the guide"), "markdown")
        ),
    )
