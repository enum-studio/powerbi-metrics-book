from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import object_of, objects_in, one_line, query_of
from powerbi_metrics_book.calls import MAX_PAGES, show_object
from powerbi_metrics_book.client import ApiError, Json, api_path
from powerbi_metrics_book.files import read_text_file
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import line, print_fields

app = typer.Typer(
    help="The descriptions you write for datasets, tables, columns and measures.",
    no_args_is_help=True,
)

Kind = Annotated[
    str, typer.Argument(help="What it is: dataset, table, column or measure.")
]
ElementId = Annotated[str, typer.Argument(help="The element's id.")]

# The api's name of each built-in field: its flag, and the kinds that carry it.
FIELD_FLAGS = {
    "when_to_use": ("--when-to-use", ("dataset",)),
    "owner": ("--owner", ("dataset",)),
    "freshness": ("--freshness", ("dataset",)),
    "caveats": ("--caveats", ("dataset", "table")),
    "grain_and_filters": ("--grain", ("table",)),
    "unit": ("--unit", ("column",)),
    "blank_means": ("--blank-means", ("column",)),
}


def refuse_fields_the_kind_lacks(kind: str, given: dict[str, str]) -> None:
    allowed = [flag for flag, kinds in FIELD_FLAGS.values() if kind in kinds]
    for name in given:
        flag, kinds = FIELD_FLAGS[name]
        if kind not in kinds:
            have = ", ".join(allowed) if allowed else "no field flags"
            raise typer.BadParameter(
                f"{flag} is not a field of a {kind}. A {kind} takes {have}"
                " (and --description or --file)."
            )


def print_docs(console: Console, docs: dict[str, Json]) -> None:
    """The answer's fields, leaving out a built-in field that is not set."""
    print_fields(
        console,
        {
            name: value
            for name, value in docs.items()
            if name not in FIELD_FLAGS or value is not None
        },
    )


@app.command("check")
def check(
    context: typer.Context,
    dataset: Annotated[
        str | None, typer.Option(help="Check only this dataset, by name or id.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List missing required documentation and unused conventions exceptions.

    Exits 1 when anything fails. --json combines every page of checks.
    """
    with open_session(context, json_output) as session:
        answer = object_of(
            session.client.get("/docs/checks", query_of(dataset=dataset, limit=500)),
            "the documentation checks",
        )
        items = objects_in(answer, "items")
        unused = objects_in(answer, "unused_exceptions")
        page = answer
        seen: set[str] = set()
        for _ in range(MAX_PAGES):
            cursor = page.get("next_cursor")
            if not isinstance(cursor, str):
                break
            if cursor in seen:
                raise ApiError(
                    "upstream",
                    "The api's documentation checks did not come to an end.",
                    200,
                )
            seen.add(cursor)
            page = object_of(
                session.client.get(
                    "/docs/checks", query_of(dataset=dataset, limit=500, cursor=cursor)
                ),
                "the documentation checks",
            )
            items += objects_in(page, "items")
        else:
            raise ApiError(
                "upstream",
                "The api's documentation checks did not come to an end.",
                200,
            )

        failures: list[str] = []
        for item in items:
            path = one_line(item["dataset"])
            if item["kind"] == "column":
                path += f" / {one_line(item['table'])}"
            if item["kind"] != "dataset":
                path += f" / {one_line(item['name'])}"
            for result in objects_in(item, "results"):
                if result["passed"] is not True:
                    failures.append(
                        f"{path}: {one_line(result['rule'])}: "
                        f"{one_line(result['message'])}"
                    )
        for exception in unused:
            target = object_of(exception["target"], "the exception target")
            if "column" in target or "table" in target:
                kind = "column" if "column" in target else "table"
                named = (
                    f"{kind} {one_line(target[kind])} in {one_line(target['dataset'])}"
                )
            else:
                named = " ".join(
                    f"{key} {one_line(value)}" for key, value in target.items()
                )
            why = one_line(exception["why"])
            if why == "ambiguous":
                why = "the dataset name is ambiguous; use its id"
            failures.append(
                f"conventions.exception_unused: {one_line(exception['rule'])} "
                f"on {named}: {why}"
            )

        total: Json = 1
        if not failures and not json_output and dataset is None:
            total = object_of(
                session.client.get("/datasets", {"limit": 1}), "the datasets"
            )["total"]

        def render(console: Console) -> None:
            for failure in failures:
                line(console, failure)
            if failures:
                line(console, f"{len(failures)} checks fail.")
            else:
                noun = "dataset" if total == 1 else "datasets"
                line(
                    console,
                    f"All documentation checks pass on {one_line(total)} {noun}.",
                )

        session.emit(
            {
                "items": list(items),
                "failing": answer["failing"],
                "unused_exceptions": list(unused),
            },
            render,
        )
    if failures:
        raise typer.Exit(1)


@app.command("show")
def show(
    context: typer.Context,
    kind: Kind,
    element_id: ElementId,
    json_output: JsonOption = False,
) -> None:
    """Show an element's description, who wrote it, its fields and custom fields.

    Example: pbmb docs show column 7c9e6679-7425-40de-944b-e07fc1f90ae7
    """
    show_object(
        context,
        json_output,
        "GET",
        api_path("elements", kind, element_id, "docs"),
        "the description",
        render=print_docs,
    )


@app.command("set")
def set_description(
    context: typer.Context,
    kind: Kind,
    element_id: ElementId,
    description: Annotated[
        str | None, typer.Option(help="The description, as plain text or Markdown.")
    ] = None,
    file: Annotated[
        Path | None,
        typer.Option(help="Read the description from this UTF-8 text file."),
    ] = None,
    when_to_use: Annotated[
        str | None, typer.Option(help="Dataset: when to use it, and when not.")
    ] = None,
    owner: Annotated[str | None, typer.Option(help="Dataset: who owns it.")] = None,
    freshness: Annotated[
        str | None, typer.Option(help="Dataset: how fresh its data is.")
    ] = None,
    caveats: Annotated[
        str | None, typer.Option(help="Dataset or table: what to watch for.")
    ] = None,
    grain: Annotated[
        str | None,
        typer.Option(help="Table: what a row is, and what the table leaves out."),
    ] = None,
    unit: Annotated[str | None, typer.Option(help="Column: its unit.")] = None,
    blank_means: Annotated[
        str | None, typer.Option(help="Column: what a blank value means.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Set an element's description and, for a dataset, table or column, its fields.

    A description replaces the one written before. Give --description or
    --file, and the flags of the element's kind: a dataset takes
    --when-to-use, --owner, --freshness and --caveats, a table --grain and
    --caveats, a column --unit and --blank-means.

    Example: pbmb docs set measure 7c9e6679-7425-40de-944b-e07fc1f90ae7 --file net.md
    """
    if description is not None and file is not None:
        raise typer.BadParameter("Give only one of --description and --file.")
    given = {
        name: value
        for name, value in {
            "when_to_use": when_to_use,
            "owner": owner,
            "freshness": freshness,
            "caveats": caveats,
            "grain_and_filters": grain,
            "unit": unit,
            "blank_means": blank_means,
        }.items()
        if value is not None
    }
    if description is None and file is None and not given:
        raise typer.BadParameter(
            "Give --description or --file, or a field flag such as --owner."
        )
    refuse_fields_the_kind_lacks(kind, given)
    body: dict[str, Json] = dict(given)
    if file is not None:
        body["description"] = read_text_file(file)
    elif description is not None:
        body["description"] = description
    show_object(
        context,
        json_output,
        "PUT",
        api_path("elements", kind, element_id, "docs"),
        "the description",
        body=body,
    )
