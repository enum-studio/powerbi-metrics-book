from datetime import UTC, datetime, timedelta
from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import (
    object_of,
    objects_in,
    one_line,
    plain,
    query_of,
)
from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import ApiError, Json
from powerbi_metrics_book.output import JsonOption

app = typer.Typer(help="Report what the book is missing and what needs structure.")


def _render(console: Console, answer: dict[str, Json]) -> None:
    def line(value: str) -> None:
        console.print(value, markup=False, highlight=False, soft_wrap=True)

    def cell(value: Json) -> str:
        return plain(one_line(value)).replace("|", "\\|")

    listed = answer["truncated_lists"]
    if not isinstance(listed, list):
        raise ApiError(
            "upstream", "The api did not answer truncated_lists as a list.", 200
        )
    truncated = {str(name) for name in listed}
    line("Totals: " + cell(answer["totals"]))
    line("Hidden: " + cell(answer["hidden"]))
    for section in ("not_covered", "badly_structured"):
        for name in object_of(answer[section], section):
            rows = objects_in(object_of(answer[section], section), name)
            line("\n### " + name + (" (truncated)" if name in truncated else ""))
            columns = list(rows[0]) if rows else ["entries"]
            line("| " + " | ".join(columns) + " |")
            line("| " + " | ".join("---" for _ in columns) + " |")
            for row in rows:
                line("| " + " | ".join(cell(row[column]) for column in columns) + " |")


@app.command("report")
def report(
    context: typer.Context,
    since: Annotated[
        str, typer.Option(help="Start as an ISO time or days back, such as 30d.")
    ],
    until: Annotated[
        str | None, typer.Option(help="End as an ISO time; now if omitted.")
    ] = None,
    dataset: Annotated[str | None, typer.Option(help="Dataset name or id.")] = None,
    limit: Annotated[
        int | None, typer.Option(help="Most rows per list, at most 100.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Show coverage and structure gaps as Markdown tables, for curators and admins."""
    if since.endswith("d") and since[:-1].isdigit():
        since = (datetime.now(UTC) - timedelta(days=int(since[:-1]))).isoformat()
    show_object(
        context,
        json_output,
        "GET",
        "/usage/report",
        "the usage report",
        query=query_of(since=since, until=until, dataset=dataset, limit=limit),
        render=_render,
    )
