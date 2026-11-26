from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import (
    Custom,
    custom_fields,
    custom_filters,
    list_or_none,
    objects_in,
    query_of,
    text_of,
    text_or_none,
)
from powerbi_metrics_book.calls import show_done, show_object
from powerbi_metrics_book.client import Json, Query, api_path
from powerbi_metrics_book.output import JsonOption
from powerbi_metrics_book.tables import line, print_fields, print_table, render_page

app = typer.Typer(
    help="A term is a word the business uses that a newcomer needs explained: "
    "Returning customer, Sign-up attribution, Cohort, Channel. A term can point "
    "to the columns that hold it and the metrics that use it."
)

LIST_COLUMNS = ["name", "type", "trust_state", "owner", "summary"]
COLUMN_COLUMNS = ["id", "name", "data_type", "table.name", "dataset.name"]

Name = Annotated[str, typer.Argument(help="The term's name.")]
Definition = Annotated[str | None, typer.Option(help="What the term means.")]
Aliases = Annotated[
    str | None, typer.Option(help="Other names, comma-separated, or `none`.")
]
NotTheSameAs = Annotated[
    str | None, typer.Option(help="What it is mistaken for, or `none`.")
]
Values = Annotated[
    str | None,
    typer.Option(help="The values the term takes, comma-separated, or `none`."),
]
Owner = Annotated[str | None, typer.Option(help="Who answers for the term.")]
Metric = Annotated[str, typer.Argument(help="The metric's id or name.")]


def _show_term(console: Console, term: dict[str, Json]) -> None:
    print_fields(
        console,
        {
            "name": term.get("name"),
            "type": term.get("type"),
            "trust_state": term.get("trust_state"),
            "definition": term.get("definition"),
            "aliases": term.get("aliases"),
            "not_the_same_as": term.get("not_the_same_as"),
            "values": term.get("values"),
            "owner": term.get("owner"),
            "custom": term.get("custom"),
            "metrics": [
                text_of(metric.get("name")) for metric in objects_in(term, "metrics")
            ],
            **(
                {"open_questions": term["open_questions"]}
                if "open_questions" in term
                else {}
            ),
        },
    )
    line(console, "\nColumns behind it")
    print_table(console, objects_in(term, "columns"), COLUMN_COLUMNS)


def _body(
    definition: str | None,
    aliases: str | None,
    not_the_same_as: str | None,
    values: str | None,
    owner: str | None,
    custom: list[str] | None,
) -> dict[str, Json]:
    body: dict[str, Json] = {}
    if definition is not None:
        body["definition"] = definition
    if aliases is not None:
        body["aliases"] = list_or_none(aliases)
    if not_the_same_as is not None:
        body["not_the_same_as"] = text_or_none(not_the_same_as)
    if values is not None:
        body["values"] = list_or_none(values)
    if owner is not None:
        body["owner"] = owner
    if custom:
        body["custom"] = custom_fields(custom)
    return body


def _term(
    context: typer.Context,
    json_output: bool,
    method: str,
    path: str,
    body: Json = None,
) -> None:
    show_object(
        context, json_output, method, path, "the term", body=body, render=_show_term
    )


@app.command("list")
def list_terms(
    context: typer.Context,
    dataset: Annotated[
        str | None, typer.Option(help="Only terms backed by a column in this dataset.")
    ] = None,
    workspace: Annotated[
        str | None,
        typer.Option(help="Only terms backed by a column in this workspace."),
    ] = None,
    app_name: Annotated[
        str | None,
        typer.Option("--app", help="Only terms backed by a column in this app."),
    ] = None,
    trust_state: Annotated[
        list[str] | None,
        typer.Option(help="Only this trust state; repeat for several."),
    ] = None,
    custom: Annotated[
        list[str] | None,
        typer.Option(help="Only terms whose custom field matches, key=value."),
    ] = None,
    limit: Annotated[int | None, typer.Option(help="At most this many.")] = None,
    cursor: Annotated[
        str | None, typer.Option(help="The cursor the last page ended with.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List the words the business uses, A to Z.

    A term with columns has type dimension; one with none has type concept."""
    query: Query = {
        **query_of(
            dataset=dataset,
            workspace=workspace,
            app=app_name,
            trust_states=",".join(trust_state) if trust_state else None,
            limit=limit,
            cursor=cursor,
        ),
        **custom_filters(custom),
    }
    show_object(
        context,
        json_output,
        "GET",
        "/terms",
        "the terms",
        query=query,
        render=render_page(LIST_COLUMNS),
    )


@app.command("show")
def show(context: typer.Context, name: Name, json_output: JsonOption = False) -> None:
    """Show what the business means by a word, its values, columns and metrics."""
    _term(context, json_output, "GET", api_path("terms", name))


@app.command("create")
def create(
    context: typer.Context,
    name: Name,
    definition: Annotated[str, typer.Option(help="What the term means.")],
    aliases: Aliases = None,
    not_the_same_as: NotTheSameAs = None,
    values: Values = None,
    owner: Owner = None,
    custom: Custom = None,
    json_output: JsonOption = False,
) -> None:
    """Create a term. Link columns to it with `pbmb terms link`."""
    body = _body(definition, aliases, not_the_same_as, values, owner, custom)
    _term(context, json_output, "POST", api_path("terms", name), body)


@app.command("update")
def update(
    context: typer.Context,
    name: Name,
    new_name: Annotated[str | None, typer.Option("--name", help="Rename it.")] = None,
    definition: Definition = None,
    aliases: Aliases = None,
    not_the_same_as: NotTheSameAs = None,
    values: Values = None,
    owner: Owner = None,
    custom: Custom = None,
    json_output: JsonOption = False,
) -> None:
    """Change the fields you name and leave the rest."""
    body = _body(definition, aliases, not_the_same_as, values, owner, custom)
    if new_name is not None:
        body["name"] = new_name
    if not body:
        raise typer.BadParameter("Name at least one field to change.")
    _term(context, json_output, "PATCH", api_path("terms", name), body)


@app.command("link")
def link(
    context: typer.Context,
    name: Name,
    column_id: Annotated[str, typer.Argument(help="The column's id.")],
    json_output: JsonOption = False,
) -> None:
    """Make a column back the term, so the term's values are that column's."""
    _term(context, json_output, "PUT", api_path("terms", name, "columns", column_id))


@app.command("unlink")
def unlink(
    context: typer.Context,
    name: Name,
    column_id: Annotated[str, typer.Argument(help="The column's id.")],
    json_output: JsonOption = False,
) -> None:
    """Stop a column backing the term."""
    _term(context, json_output, "DELETE", api_path("terms", name, "columns", column_id))


@app.command("relate")
def relate(
    context: typer.Context,
    name: Name,
    metric: Metric,
    json_output: JsonOption = False,
) -> None:
    """Relate the term to a metric, so the metric lists it among its terms.

    Example: pbmb terms relate Order number_of_orders
    """
    _term(context, json_output, "PUT", api_path("terms", name, "metrics", metric))


@app.command("unrelate")
def unrelate(
    context: typer.Context,
    name: Name,
    metric: Metric,
    json_output: JsonOption = False,
) -> None:
    """Stop relating the term to a metric.

    Example: pbmb terms unrelate Order number_of_orders
    """
    _term(context, json_output, "DELETE", api_path("terms", name, "metrics", metric))


@app.command("delete")
def delete(context: typer.Context, name: Name, json_output: JsonOption = False) -> None:
    """Delete a term."""
    show_done(
        context,
        json_output,
        "DELETE",
        api_path("terms", name),
        {"deleted": name},
        f"Deleted the term {name}.",
    )


@app.command("group")
def set_group(
    context: typer.Context, name: str, group: str, json_output: JsonOption = False
) -> None:
    """Set the glossary group of a term."""
    _term(context, json_output, "PATCH", api_path("terms", name), {"group": group})
