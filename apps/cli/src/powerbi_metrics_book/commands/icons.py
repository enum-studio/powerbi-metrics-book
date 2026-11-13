from typing import Annotated, Literal

import typer

from powerbi_metrics_book.answers import (
    object_of,
    objects_in,
    objects_of,
    one_line,
    string_field,
)
from powerbi_metrics_book.calls import GUID, dataset_id
from powerbi_metrics_book.client import ApiError, Client, Json, api_path
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import print_fields

app = typer.Typer(help="Set, clear and browse icons for the book.")
Kind = Literal["metric", "category", "term", "dataset", "workspace"]
Reference = Annotated[
    str, typer.Argument(help="The name, category key path or Power BI id.")
]


def _categories(nodes: list[dict[str, Json]]) -> list[dict[str, Json]]:
    return [
        item
        for node in nodes
        for item in [node, *_categories(objects_in(node, "children"))]
    ]


def _resolve(client: Client, kind: Kind, reference: str) -> str:
    if kind in ("metric", "term"):
        return string_field(
            object_of(client.get(api_path(f"{kind}s", reference)), f"the {kind}"), "id"
        )
    if kind == "dataset":
        return dataset_id(client, reference)
    if kind == "workspace" and GUID.fullmatch(reference):
        return reference
    route = "/categories" if kind == "category" else "/workspaces"
    nodes = objects_of(client.get(route), f"the {kind}s")
    if kind == "category":
        nodes = _categories(nodes)
    field = "path" if kind == "category" else "name"
    found = [node for node in nodes if node.get(field) == reference]
    if not found:
        command = "categories tree" if kind == "category" else "workspaces list"
        raise ApiError(
            "not_found",
            f"No {kind} named {one_line(reference)} that you may see. "
            f"Run `pbmb {command}` to see them.",
            404,
        )
    if len(found) > 1:
        candidates = ", ".join(one_line(string_field(node, "id")) for node in found)
        raise typer.BadParameter(
            f"Several {route[1:]} are named {one_line(reference)}. "
            f"Use the id of one: {candidates}."
        )
    return string_field(found[0], "id")


def _icon(value: str) -> str:
    if value.startswith(("emoji:", "glyph:")):
        return value
    if not value.isascii():
        return f"emoji:{value}"
    return f"glyph:{value}" if ":" in value else f"glyph:{value}:gray"


@app.command("set")
def set_icon(
    context: typer.Context,
    kind: Kind,
    ref: Reference,
    icon: Annotated[str, typer.Argument(help="An emoji or glyph name[:color].")],
    json_output: JsonOption = False,
) -> None:
    """Give an element an icon. A glyph without a color takes gray.

    Example: pbmb icons set metric net_sales 📈
    Example: pbmb icons set dataset Sales chart-line:green
    """
    with open_session(context, json_output) as session:
        element_id = _resolve(session.client, kind, ref)
        answer = object_of(
            session.client.request(
                "PUT",
                api_path("elements", kind, element_id, "icon", answered_by_api=True),
                body={"icon": _icon(icon)},
            ),
            "the icon",
        )
        session.emit(answer, lambda console: print_fields(console, answer))


@app.command("clear")
def clear(
    context: typer.Context,
    kind: Kind,
    ref: Reference,
    json_output: JsonOption = False,
) -> None:
    """Clear an element's chosen icon.

    Example: pbmb icons clear metric net_sales
    """
    with open_session(context, json_output) as session:
        element_id = _resolve(session.client, kind, ref)
        answer = object_of(
            session.client.request(
                "DELETE",
                api_path("elements", kind, element_id, "icon", answered_by_api=True),
            ),
            "the icon",
        )
        session.emit(answer, lambda console: print_fields(console, answer))


@app.command("list")
def list_icons(
    context: typer.Context,
    search: Annotated[
        str | None, typer.Option(help="Only glyph names containing this text.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List the available glyph names and colors.

    Example: pbmb icons list --search chart
    """
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/icons"), "the icons")
        if search is not None:
            glyphs = answer.get("glyphs")
            if not isinstance(glyphs, list):
                raise ApiError(
                    "upstream", "The api did not answer a list of glyphs.", 200
                )
            answer["glyphs"] = [
                glyph for glyph in glyphs if isinstance(glyph, str) and search in glyph
            ]
        session.emit(answer, lambda console: print_fields(console, answer))
