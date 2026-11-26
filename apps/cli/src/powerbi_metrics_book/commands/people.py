from typing import Annotated

import typer

from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import api_path
from powerbi_metrics_book.output import JsonOption

app = typer.Typer(help="Update your title, or another person's as an admin.")


@app.command("title")
def title(
    context: typer.Context,
    title: str,
    person: Annotated[str, typer.Option(help="The person's id, or me.")] = "me",
    json_output: JsonOption = False,
) -> None:
    """Set the title shown beside a person's name."""
    show_object(
        context,
        json_output,
        "PUT",
        api_path("people", person, "title"),
        "the title",
        body={"title": title},
    )
