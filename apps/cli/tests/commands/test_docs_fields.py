import json

from cli_support import URL, Serve, json_response
from commands_support import run

ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


def docs(kind: str, **fields: str | None) -> dict[str, object]:
    return {
        "element": {"kind": kind, "id": ID, "name": "Sample"},
        "description": None,
        "described_by": None,
        "custom": {},
        **fields,
    }


def test_set_sends_the_flags_of_a_dataset_as_the_api_names_them(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, docs("dataset")))

    result = run(
        *("docs", "set", "dataset", ID),
        *("--when-to-use", "Sales questions"),
        *("--owner", "Sales Operations"),
        *("--freshness", "Daily at 06:00"),
        *("--caveats", "Excludes returns"),
    )

    assert result.exit_code == 0, result.stderr
    assert json.loads(seen[0].content) == {
        "when_to_use": "Sales questions",
        "owner": "Sales Operations",
        "freshness": "Daily at 06:00",
        "caveats": "Excludes returns",
    }


def test_set_grain_writes_grain_and_filters_beside_a_description(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, docs("table")))

    run(*("docs", "set", "table", ID), *("--grain", "One row per order line"))
    run(
        *("docs", "set", "column", ID),
        *("--unit", "EUR"),
        *("--blank-means", "Not priced"),
        *("--description", "Price."),
    )

    assert [json.loads(r.content) for r in seen] == [
        {"grain_and_filters": "One row per order line"},
        {"unit": "EUR", "blank_means": "Not priced", "description": "Price."},
    ]


def test_set_refuses_a_flag_the_kind_lacks_before_any_request(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, docs("column")))

    column = run("docs", "set", "column", ID, "--owner", "Ada")
    measure = run("docs", "set", "measure", ID, "--unit", "EUR")

    assert (column.exit_code, measure.exit_code) == (2, 2)
    assert "--owner is not a field of a column" in column.stderr
    assert "--unit, --blank-means" in column.stderr
    assert "no field flags" in measure.stderr
    assert seen == []


def test_show_prints_the_fields_that_are_set_and_leaves_out_the_rest(
    serve: Serve,
) -> None:
    serve(
        lambda request: json_response(
            200, docs("dataset", owner="Sales Operations", freshness=None)
        )
    )

    result = run("docs", "show", "dataset", ID)

    assert result.exit_code == 0, result.stderr
    assert "Sales Operations" in result.stdout
    assert "freshness" not in result.stdout
    assert URL
