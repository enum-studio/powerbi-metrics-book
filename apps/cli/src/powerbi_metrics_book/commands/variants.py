from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import (
    dax_block,
    dig,
    key_values,
    query_of,
    text_of,
)
from powerbi_metrics_book.calls import show_object
from powerbi_metrics_book.client import Json, api_path
from powerbi_metrics_book.output import JsonOption
from powerbi_metrics_book.tables import line, print_fields, render_page

app = typer.Typer(help="One measure in one dataset: its DAX and its shift.")

COLUMNS = [
    "id",
    "dataset.name",
    "workspace.name",
    "measure.name",
    "measure_reference",
    "shift.period",
    "shift.comparison",
    "shift.comparison_period",
    "shift.currency",
    "shift.custom_axes",
]

VariantId = Annotated[str, typer.Argument(metavar="ID", help="The variant's id.")]


def _show_variant(console: Console, variant: dict[str, Json]) -> None:
    print_fields(
        console,
        {
            "id": variant.get("id"),
            "metric": dig(variant, "metric.name"),
            "dataset": dig(variant, "dataset.name"),
            "workspace": dig(variant, "workspace.name"),
            "table": dig(variant, "table.name"),
            "measure": dig(variant, "measure.name"),
            "measure_reference": variant.get("measure_reference"),
            "reads_selection": variant.get("reads_selection"),
            "selection_columns": variant.get("selection_columns"),
            "format_string": variant.get("format_string"),
            "display_folder": variant.get("display_folder"),
            "description": variant.get("description"),
            "description_pbi": variant.get("description_pbi"),
            "shift": variant.get("shift"),
            "assigned_by": variant.get("assigned_by"),
        },
    )
    line(console, "\n" + dax_block(text_of(variant.get("expression"))))


@app.command("list")
def list_variants(
    context: typer.Context,
    metric: Annotated[str, typer.Argument(help="The metric, by key, alias or id.")],
    dataset: Annotated[
        str | None, typer.Option(help="Only this dataset (id or name).")
    ] = None,
    workspace: Annotated[
        str | None, typer.Option(help="Only this workspace (id or name).")
    ] = None,
    period: Annotated[
        str | None, typer.Option(help="Only this period, such as previous_year.")
    ] = None,
    comparison: Annotated[
        str | None,
        typer.Option(help="Only this one: none, difference, growth_rate or ratio."),
    ] = None,
    currency: Annotated[
        str | None,
        typer.Option(help="Only this currency code. Empty is the dataset's own."),
    ] = None,
    limit: Annotated[
        int | None, typer.Option(help="At most this many (1 to 500).")
    ] = None,
    cursor: Annotated[
        str | None, typer.Option(help="Continue from the cursor a page ended with.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List a metric's variants, with their ids and shifts and no DAX.

    `pbmb variants show <id>` gives one's DAX, such as to compare two metrics
    before a merge.

    Example: pbmb variants list number_of_orders --period previous_year
    """
    show_object(
        context,
        json_output,
        "GET",
        api_path("metrics", metric, "variants"),
        "the variants",
        query=query_of(
            dataset=dataset,
            workspace=workspace,
            period=period,
            comparison=comparison,
            currency=currency,
            limit=limit,
            cursor=cursor,
        ),
        render=render_page(COLUMNS),
    )


@app.command("show")
def show(
    context: typer.Context, variant_id: VariantId, json_output: JsonOption = False
) -> None:
    """Show a variant: its metric, dataset, measure_reference, shift and DAX.

    Use this DAX against its dataset instead of writing your own.
    """
    show_object(
        context,
        json_output,
        "GET",
        api_path("variants", variant_id),
        "the variant",
        render=_show_variant,
    )


@app.command("move")
def move(
    context: typer.Context,
    variant_id: VariantId,
    to: Annotated[str, typer.Option(help="The metric that should own the variant.")],
    period: Annotated[
        str | None, typer.Option(help="Its period, such as previous_year.")
    ] = None,
    comparison: Annotated[
        str | None,
        typer.Option(help="none, difference, growth_rate or ratio."),
    ] = None,
    comparison_period: Annotated[
        str | None, typer.Option(help="The period it is compared with.")
    ] = None,
    currency: Annotated[str | None, typer.Option(help="Its currency code.")] = None,
    axis: Annotated[
        list[str] | None,
        typer.Option(help="A custom axis, key=value; repeat it."),
    ] = None,
    note: Annotated[str | None, typer.Option(help="Why it is shifted.")] = None,
    json_output: JsonOption = False,
) -> None:
    """Move a variant under another metric, and set how it is shifted from it.

    A variant is the metric's calculation shifted on currency, period or
    comparison only; a different calculation is a different metric.
    """
    given = {
        "to_metric": to,
        "period": period,
        "comparison": comparison,
        "comparison_period": comparison_period,
        "currency": currency,
        "note": note,
    }
    body: dict[str, Json] = {
        field: value for field, value in given.items() if value is not None
    }
    if axis:
        # A copy: dict[str, str] is not a dict[str, Json] to the type checker.
        body["custom_axes"] = dict(key_values(axis, "--axis"))
    show_object(
        context,
        json_output,
        "PATCH",
        api_path("variants", variant_id),
        "the variant",
        body=body,
        render=_show_variant,
    )
