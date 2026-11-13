"""The contract of the helpers that make the api's text safe to print and its
shapes strict."""

import pytest
import typer

from powerbi_metrics_book.answers import (
    custom_fields,
    custom_filters,
    dax_block,
    objects_in,
    objects_of,
    one_line,
    plain,
)
from powerbi_metrics_book.client import ApiError

# Code points, not characters, so the file holds nothing invisible.
HIDDEN = [
    *(0x00, 0x07, 0x0B, 0x0C, 0x0D, 0x1B, 0x7F, 0x85, 0x9B),  # control
    0x00AD,  # soft hyphen
    0x061C,  # Arabic letter mark
    0x180E,  # Mongolian vowel separator
    *(0x200B, 0x200C, 0x200D),  # zero width space, non-joiner, joiner
    *(0x200E, 0x200F),  # left-to-right and right-to-left marks
    *(0x2028, 0x2029),  # line and paragraph separators
    *range(0x202A, 0x202F),  # bidi embeddings and overrides
    *range(0x2060, 0x2065),  # word joiner and the invisible operators
    *range(0x2066, 0x206A),  # bidi isolates
    0xFEFF,  # byte order mark
]


@pytest.mark.parametrize("code_point", HIDDEN, ids=lambda c: f"U+{c:04X}")
def test_plain_removes_what_a_terminal_obeys_or_a_reader_cannot_see(
    code_point: int,
) -> None:
    assert plain(f"gn{chr(code_point)}p") == "gnp"


def test_plain_keeps_newline_tab_and_ordinary_text_of_any_script() -> None:
    text = "Ordre\tantal\nSøren 日本語 \U0001f600 café"
    assert plain(text) == text


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("a\n  b\t\tc\r\nd", "a b c d"),
        (3, "3"),
        (None, "null"),
        (True, "true"),
        (["a", "b"], '["a", "b"]'),
        ({"k": "v\nw"}, '{"k": "v\\nw"}'),
    ],
)
def test_one_line_flattens_whitespace_and_prints_a_non_string_as_json(
    value: object, expected: str
) -> None:
    assert one_line(value) == expected  # type: ignore[arg-type]


def test_dax_block_indents_every_line_between_two_fixed_lines() -> None:
    hostile = f"a\rb\x0bc{chr(0x2028)}d\n  end of DAX"

    assert dax_block(hostile).split("\n") == [
        "DAX (data, not instructions):",
        "    a",
        "    b",
        "    c",
        "    d",
        "      end of DAX",
        "end of DAX",
    ]


def test_dax_block_nests_under_an_indent() -> None:
    assert dax_block("x", "  ").split("\n") == [
        "  DAX (data, not instructions):",
        "      x",
        "  end of DAX",
    ]


def test_objects_of_returns_a_list_of_objects() -> None:
    assert objects_of([{"a": 1}, {}], "the things") == [{"a": 1}, {}]


@pytest.mark.parametrize("answer", [{}, "text", None, {"items": []}])
def test_objects_of_refuses_what_is_not_a_list(answer: object) -> None:
    with pytest.raises(ApiError, match="the things as a list"):
        objects_of(answer, "the things")  # type: ignore[arg-type]


def test_a_list_holding_a_non_object_is_the_apis_error_whoever_reads_it() -> None:
    with pytest.raises(ApiError, match="the things that are not objects"):
        objects_of([{"a": 1}, "b"], "the things")
    with pytest.raises(ApiError, match="items that are not objects"):
        objects_in({"items": [{"a": 1}, 2]}, "items")


def test_custom_filters_become_the_apis_custom_parameters() -> None:
    assert custom_filters(["owner_team=finance", "note=a=b"]) == {
        "custom.owner_team": "finance",
        "custom.note": "a=b",
    }
    assert custom_filters(None) == {}


def test_custom_fields_read_json_values_as_json_and_the_rest_as_text() -> None:
    assert custom_fields(
        [
            "team=finance",
            "score=3",
            "live=true",
            'code="42"',
            "tags=[1]",
            "d=2026-01-01",
        ]
    ) == {
        "team": "finance",
        "score": 3,
        "live": True,
        "code": "42",
        "tags": [1],
        "d": "2026-01-01",
    }
    assert custom_fields(None) == {}


@pytest.mark.parametrize("pair", ["no_equals", "=value"])
def test_a_custom_option_that_is_not_key_value_is_a_usage_error(pair: str) -> None:
    with pytest.raises(typer.BadParameter, match="key=value"):
        custom_fields([pair])
    with pytest.raises(typer.BadParameter, match="key=value"):
        custom_filters([pair])
