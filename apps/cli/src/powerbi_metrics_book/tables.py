"""Printing answers for people: tables, field lists and row grids.

Every value goes through `plain` and `Text`: control characters are removed,
and rich does not read [brackets] in a value as markup.
"""

import json
from collections.abc import Callable, Sequence

from rich.console import Console
from rich.table import Table
from rich.text import Text

from powerbi_metrics_book.answers import dig, objects_in, plain, text_of
from powerbi_metrics_book.client import ApiError, Json


def cell(value: Json) -> Text:
    if value is None:
        return Text("-")
    return Text(plain(value if isinstance(value, str) else json.dumps(value)))


def _in_table(value: Json) -> Json:
    """A list of strings as one comma-separated string."""
    if isinstance(value, list):
        names = [item for item in value if isinstance(item, str)]
        if len(names) == len(value):
            return ", ".join(names)
    return value


def print_table(
    console: Console, rows: Sequence[dict[str, Json]], columns: Sequence[str]
) -> None:
    """One row per object and one column per dotted path (`dataset.name`)."""
    table = Table(box=None)
    for column in columns:
        table.add_column(column.replace(".", " "))
    for row in rows:
        table.add_row(*(cell(_in_table(dig(row, column))) for column in columns))
    console.print(table)


def print_fields(console: Console, fields: dict[str, Json]) -> None:
    table = Table(show_header=False, box=None)
    for name, value in fields.items():
        table.add_row(Text(plain(name)), cell(value))
    console.print(table)


def print_rows(console: Console, answer: dict[str, Json], rows_key: str) -> None:
    """The columns and the rows (under rows_key) of a query or result answer."""
    table = Table(box=None)
    for column in objects_in(answer, "columns"):
        table.add_column(Text(plain(text_of(column.get("name")))))
    rows = answer.get(rows_key)
    if not isinstance(rows, list):
        raise ApiError("upstream", f"The api did not answer {rows_key}.", 200)
    for row in rows:
        if not isinstance(row, list):
            raise ApiError(
                "upstream",
                f"The api answered a row of {rows_key} that is not a list.",
                200,
            )
        table.add_row(*(cell(value) for value in row))
    console.print(table)


def line(console: Console, text: str) -> None:
    console.print(Text(plain(text)))


def render_page(columns: list[str]) -> Callable[[Console, dict[str, Json]], None]:
    def render(console: Console, page: dict[str, Json]) -> None:
        print_table(console, objects_in(page, "items"), columns)
        cursor = page.get("next_cursor")
        if isinstance(cursor, str):
            console.print(Text(plain(f"More: repeat with --cursor {cursor}")))

    return render
