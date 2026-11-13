from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import objects_in, objects_of, one_line, query_of
from powerbi_metrics_book.calls import show_done, show_object
from powerbi_metrics_book.client import Json, api_path
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import line

app = typer.Typer(help="The folders metrics are filed in.")

CategoryPath = Annotated[
    str, typer.Argument(help="The category's key path, such as sales/orders.")
]


def _category_path(path: str) -> str:
    """The route of a category: each key of its path is one escaped segment."""
    return api_path("categories", *path.split("/"))


def _print_level(console: Console, nodes: list[dict[str, Json]], depth: int) -> None:
    for node in nodes:
        described = (
            f"  {one_line(node['description'])}" if node.get("description") else ""
        )
        line(
            console,
            f"{'  ' * depth}{one_line(node.get('path'))}  "
            f"{one_line(node.get('name'))} "
            f"({one_line(node.get('metric_count'))} metrics){described}",
        )
        _print_level(console, objects_in(node, "children"), depth + 1)


@app.command("tree")
def tree(
    context: typer.Context,
    parent: Annotated[
        str | None, typer.Option(help="Only the tree below this category's path.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Show every category with its path and the number of metrics filed in it."""
    with open_session(context, json_output) as session:
        nodes = session.client.get("/categories", query_of(parent=parent))
        session.emit(
            nodes,
            lambda console: _print_level(
                console, objects_of(nodes, "the categories"), 0
            ),
        )


@app.command("create")
def create(
    context: typer.Context,
    path: CategoryPath,
    name: Annotated[
        str | None, typer.Option(help="Its name in words; else made from the key.")
    ] = None,
    description: Annotated[str | None, typer.Option(help="What is filed here.")] = None,
    json_output: JsonOption = False,
) -> None:
    """Create a category. Its parent is the path before the last key, and must exist."""
    key = path.rsplit("/", 1)[-1]
    body: dict[str, Json] = {"name": name or key.replace("_", " ").capitalize()}
    if description is not None:
        body["description"] = description
    show_object(
        context, json_output, "POST", _category_path(path), "the category", body=body
    )


@app.command("rename")
def rename(
    context: typer.Context,
    path: CategoryPath,
    name: Annotated[str | None, typer.Option(help="Its new name in words.")] = None,
    key: Annotated[
        str | None, typer.Option(help="Its new key; the path of what is below changes.")
    ] = None,
    description: Annotated[
        str | None, typer.Option(help="Its new description.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Change a category's name, key or description."""
    given = {"name": name, "key": key, "description": description}
    body: dict[str, Json] = {
        field: value for field, value in given.items() if value is not None
    }
    if not body:
        raise typer.BadParameter("Give --name, --key or --description.")
    show_object(
        context, json_output, "PATCH", _category_path(path), "the category", body=body
    )


@app.command("move")
def move(
    context: typer.Context,
    path: CategoryPath,
    to: Annotated[
        str | None, typer.Option(help="The category's new parent, by path.")
    ] = None,
    top_level: Annotated[
        bool, typer.Option("--top-level", help="Move it to the top, below no parent.")
    ] = False,
    position: Annotated[
        int | None, typer.Option(help="Its place among its new siblings.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Move a category, with what is below it, under another one."""
    if (to is None) == (not top_level):
        raise typer.BadParameter("Give the new parent with --to, or --top-level.")
    body: dict[str, Json] = {"parent": to}
    if position is not None:
        body["position"] = position
    show_object(
        context, json_output, "PATCH", _category_path(path), "the category", body=body
    )


@app.command("delete")
def delete(
    context: typer.Context, path: CategoryPath, json_output: JsonOption = False
) -> None:
    """Delete an empty category: one with no metrics and no categories below."""
    show_done(
        context,
        json_output,
        "DELETE",
        _category_path(path),
        {"deleted": path},
        f"Deleted the category {path}.",
    )
