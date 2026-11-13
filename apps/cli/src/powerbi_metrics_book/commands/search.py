from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import (
    Custom,
    custom_filters,
    objects_in,
    one_line,
    query_of,
)
from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import Json
from powerbi_metrics_book.output import JsonOption
from powerbi_metrics_book.tables import line, print_table

COLUMNS = ["kind", "id", "name", "dataset.name", "trust_state", "match", "summary"]


def _render(console: Console, answer: dict[str, Json]) -> None:
    print_table(console, objects_in(answer, "items"), COLUMNS)
    note = answer.get("note")
    if isinstance(note, str):
        line(console, one_line(note))


def command(
    context: typer.Context,
    words: Annotated[list[str], typer.Argument(help="What to look for.")],
    kind: Annotated[
        list[str] | None,
        typer.Option(
            help="Only these kinds: metric, variant, column, term, dataset, table "
            "or category. Repeat, or separate with commas."
        ),
    ] = None,
    workspace: Annotated[
        str | None, typer.Option(help="Only inside this workspace (id or name).")
    ] = None,
    app_id: Annotated[
        str | None,
        typer.Option("--app", help="Only inside this app (id or name)."),
    ] = None,
    dataset: Annotated[
        str | None, typer.Option(help="Only inside this dataset (id or name).")
    ] = None,
    category: Annotated[
        str | None, typer.Option(help="Only inside this category path.")
    ] = None,
    trust_state: Annotated[
        list[str] | None,
        typer.Option(
            help="Only these: draft, agent_verified or human_verified. "
            "Repeat, or separate with commas."
        ),
    ] = None,
    unit: Annotated[str | None, typer.Option(help="Only metrics in this unit.")] = None,
    custom: Custom = None,
    limit: Annotated[int | None, typer.Option(help="At most this many.")] = None,
    json_output: JsonOption = False,
) -> None:
    """Search the book by meaning and by words, for metrics, columns and more.

    Example: pbmb search net revenue --kind metric --trust-state human_verified

    Answers the closest matches first, each with where it lives and how far it
    is verified. Searches only what you may describe.
    """
    show_object(
        context,
        json_output,
        "GET",
        "/search",
        "the search",
        query={
            **query_of(
                query=" ".join(words),
                kinds=",".join(kind) if kind else None,
                workspace=workspace,
                app=app_id,
                dataset=dataset,
                trust_states=",".join(trust_state) if trust_state else None,
                category=category,
                unit=unit,
                limit=limit,
            ),
            **custom_filters(custom),
        },
        render=_render,
    )
