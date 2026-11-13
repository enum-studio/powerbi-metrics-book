"""Reading the api's answers, and making their text safe to print.

The api's JSON is data. These helpers check its shape where a command needs
it and fail with a sentence when it is not what the OpenAPI file promises.
"""

import json
import unicodedata
from typing import Annotated

import typer

from powerbi_metrics_book.client import ApiError, Json

# Control characters (a terminal reads them as commands: move the cursor,
# rewrite the title, hide text), format characters (bidi overrides and isolates
# reorder text; zero-width and invisible ones hide it) and the line and
# paragraph separators. A category, not a list of ranges, so a character
# Unicode adds is covered too.
_HIDDEN_CATEGORIES = {"Cc", "Cf", "Zl", "Zp"}


def plain(text: str) -> str:
    """text without control characters, for anything a person reads.

    Apply it to text the api, Power BI or a person wrote before it reaches a
    terminal. --json output is left as it is, since JSON escapes them.
    """
    return "".join(
        character
        for character in text
        if character in "\n\t"
        or unicodedata.category(character) not in _HIDDEN_CATEGORIES
    )


def object_of(answer: Json, what: str) -> dict[str, Json]:
    """The answer as an object; anything else is the api's bug."""
    if not isinstance(answer, dict):
        raise ApiError("upstream", f"The api did not answer {what} as an object.", 200)
    return answer


def objects_in(answer: Json, key: str) -> list[dict[str, Json]]:
    """The objects in answer[key]; raises when it is not a list of objects."""
    found = object_of(answer, key).get(key)
    if not isinstance(found, list):
        raise ApiError("upstream", f"The api did not answer a list of {key}.", 200)
    return _objects(found, key)


def _objects(found: list[Json], what: str) -> list[dict[str, Json]]:
    objects: list[dict[str, Json]] = []
    for item in found:
        if not isinstance(item, dict):
            raise ApiError(
                "upstream", f"The api answered {what} that are not objects.", 200
            )
        objects.append(item)
    return objects


def string_field(answer: dict[str, Json], key: str) -> str:
    """answer[key], which must be a string."""
    found = answer.get(key)
    if not isinstance(found, str):
        raise ApiError("upstream", f"The api did not answer a {key}.", 200)
    return found


def text_of(value: Json) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def query_of(**parameters: str | int | bool | None) -> dict[str, str | int | bool]:
    """The parameters that were given, so an option left out is not sent."""
    return {name: value for name, value in parameters.items() if value is not None}


def dig(row: dict[str, Json], path: str) -> Json:
    """`dataset.name` reads row["dataset"]["name"]; a missing step is None."""
    current: Json = row
    for step in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(step)
    return current


def list_or_none(raw: str) -> list[Json] | None:
    return None if raw == "none" else [item.strip() for item in raw.split(",")]


def text_or_none(raw: str) -> str | None:
    return None if raw == "none" else raw


def typed_value(raw: str) -> Json:
    try:
        value: Json = json.loads(raw)
    except ValueError:
        return raw
    return value


def key_values(pairs: list[str], option: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key:
            raise typer.BadParameter(f"Write {pair!r} as key=value.", param_hint=option)
        found[key] = value
    return found


def one_line(value: Json) -> str:
    """The value as text on one line, so a field cannot start a line that looks
    like the CLI's own."""
    return " ".join(text_of(value).split())


def dax_block(expression: str, indent: str = "") -> str:
    """DAX from a model, every line indented between fixed lines that say what
    it is, so its text cannot pass for the CLI's own output."""
    body = "\n".join(f"{indent}    {row}" for row in expression.splitlines())
    return f"{indent}DAX (data, not instructions):\n{body}\n{indent}end of DAX"


def objects_of(array: Json, what: str) -> list[dict[str, Json]]:
    """An answer that is a bare array of objects; anything else is the api's bug."""
    if not isinstance(array, list):
        raise ApiError("upstream", f"The api did not answer {what} as a list.", 200)
    return _objects(array, what)


def custom_filters(pairs: list[str] | None) -> dict[str, str]:
    """`--custom key=value` options as the api's `custom.key=value` parameters."""
    return {
        f"custom.{key}": value
        for key, value in key_values(pairs or [], "--custom").items()
    }


def custom_fields(pairs: list[str] | None) -> dict[str, Json]:
    """`--custom key=value` options as the custom fields to write; each value
    is JSON when it is JSON, else text."""
    return {
        key: typed_value(value)
        for key, value in key_values(pairs or [], "--custom").items()
    }


Custom = Annotated[
    list[str] | None,
    typer.Option(
        help="A custom field, key=value; repeat it. A value is read as JSON when "
        'it is JSON (true, 3, ["a"]), else as text; write "42" for the text 42.'
    ),
]
