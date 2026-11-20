import json

import httpx
import pytest
from cli_support import Serve, json_response
from commands_support import run

from powerbi_metrics_book.client import Json


def item(kind: str = "column", name: str = "Amount") -> dict[str, Json]:
    return {
        "kind": kind,
        "id": name,
        "name": name,
        "dataset": "Sales",
        **({"table": "Sales lines"} if kind == "column" else {}),
        "results": [
            {
                "check": f"{kind}_fields",
                "rule": f"{kind}_fields.definition",
                "passed": False,
                "message": "Write a definition.",
            },
            {
                "check": f"{kind}_fields",
                "rule": f"{kind}_fields.caveats",
                "passed": True,
                "message": "Accepted exception.",
                "exception": "Kept for now.",
            },
        ],
    }


def page(
    items: list[Json],
    unused: list[Json] | None = None,
    cursor: str | None = None,
    failing: int | None = None,
) -> dict[str, Json]:
    return {
        "items": items,
        "failing": len(items) if failing is None else failing,
        "unused_exceptions": unused or [],
        "next_cursor": cursor,
    }


def test_check_prints_only_failing_results_as_plain_one_line_text(serve: Serve) -> None:
    column = item(name="[red]Amount[/red]\nnew line")
    column["dataset"] = "Sales\nbook"
    column["table"] = "Sales\nlines"
    serve(
        lambda request: json_response(
            200, page([column, item("dataset", "Sales"), item("table", "Orders")])
        )
    )

    result = run("docs", "check")

    assert result.exit_code == 1, result.stderr
    assert result.stdout.splitlines() == [
        "Sales book / Sales lines / [red]Amount[/red] new line: "
        "column_fields.definition: Write a definition.",
        "Sales: dataset_fields.definition: Write a definition.",
        "Sales / Orders: table_fields.definition: Write a definition.",
        "3 checks fail.",
    ]


@pytest.mark.parametrize(
    ("target", "printed"),
    [
        ({"metric": "gmv"}, "metric gmv"),
        ({"dataset": "Sales"}, "dataset Sales"),
        (
            {"dataset": "Sales", "table": "'Sales lines'"},
            "table 'Sales lines' in Sales",
        ),
        (
            {"dataset": "Sales", "column": "'Sales lines'[Amount]"},
            "column 'Sales lines'[Amount] in Sales",
        ),
    ],
)
def test_check_fails_on_an_unused_exception(
    serve: Serve, target: dict[str, str], printed: str
) -> None:
    unused: list[Json] = [
        {
            "rule": "column_fields.unit",
            "target": dict(target),
            "reason": "Legacy",
            "why": "passes",
        }
    ]
    seen = serve(lambda request: json_response(200, page([], unused)))

    result = run("docs", "check")

    assert result.exit_code == 1, result.stderr
    assert result.stdout.splitlines() == [
        f"conventions.exception_unused: column_fields.unit on {printed}: passes",
        "1 checks fail.",
    ]
    assert len(seen) == 1


def test_check_explains_an_ambiguous_dataset_exception(serve: Serve) -> None:
    serve(
        lambda request: json_response(
            200,
            page(
                [],
                [
                    {
                        "rule": "dataset_fields.definition",
                        "target": {"dataset": "Sales"},
                        "reason": "Legacy",
                        "why": "ambiguous",
                    }
                ],
            ),
        )
    )

    result = run("docs", "check")

    assert result.exit_code == 1
    assert "the dataset name is ambiguous; use its id" in result.stdout


@pytest.mark.parametrize("dataset", [None, "Sales"])
def test_clean_check_counts_datasets_only_when_unfiltered(
    serve: Serve, dataset: str | None
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/datasets":
            assert dict(request.url.params) == {"limit": "1"}
            return json_response(200, {"items": [], "total": 7})
        assert request.url.path == "/api/v1/docs/checks"
        assert request.url.params.get("dataset") == dataset
        return json_response(200, page([]))

    seen = serve(handle)
    result = run("docs", "check", *([] if dataset is None else ["--dataset", dataset]))

    assert result.exit_code == 0, result.stderr
    assert result.stdout.strip() == (
        "All documentation checks pass on 7 datasets."
        if dataset is None
        else "All documentation checks pass on 1 dataset."
    )
    assert len(seen) == (2 if dataset is None else 1)


@pytest.mark.parametrize("json_output", [False, True])
def test_check_collects_two_pages_without_repeating_totals_or_exceptions(
    serve: Serve, json_output: bool
) -> None:
    unused: list[Json] = [
        {
            "rule": "dataset_fields.definition",
            "target": {"dataset": "Old sales"},
            "reason": "Legacy",
            "why": "no_such_target",
        }
    ]

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/docs/checks"
        assert request.url.params["dataset"] == "Sales"
        if request.url.params.get("cursor") is None:
            return json_response(200, page([item()], unused, "next", 2))
        assert request.url.params["cursor"] == "next"
        return json_response(200, page([item("table", "Orders")], unused, failing=2))

    seen = serve(handle)
    result = run(
        "docs", "check", "--dataset", "Sales", *(["--json"] if json_output else [])
    )

    assert result.exit_code == 1, result.stderr
    assert len(seen) == 2
    if json_output:
        assert json.loads(result.stdout) == {
            "items": [item(), item("table", "Orders")],
            "failing": 2,
            "unused_exceptions": unused,
        }
    else:
        assert result.stdout.count("conventions.exception_unused:") == 1
        assert result.stdout.endswith("3 checks fail.\n")
