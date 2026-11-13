import pytest

from powerbi_metrics_book.pii_ref import parse_ref


@pytest.mark.parametrize(
    ("reference", "measure", "expected"),
    [
        ("Customer[Email]", False, ("column", "Customer", "Email")),
        ("'Customer Dim'[Email]", False, ("column", "Customer Dim", "Email")),
        ("'Cust''omer'[E]]mail]", False, ("column", "Cust'omer", "E]mail")),
        ("Customer", False, ("table", "Customer", None)),
        ("'Customer'[Email Count]", True, ("measure", "Customer", "Email Count")),
    ],
)
def test_parse_reference(
    reference: str, measure: bool, expected: tuple[str, str, str | None]
) -> None:
    parsed = parse_ref(reference, measure)
    assert (parsed.kind, parsed.table, parsed.name) == expected


def test_bad_references_name_the_supported_forms() -> None:
    for reference in (
        "",
        "[Email]",
        "Customer[Email",
        "Customer[Email]tail",
        "''",
        "''[x]",
        "t[]",
    ):
        with pytest.raises(ValueError, match=r"Table\[Column\].*whole table"):
            parse_ref(reference)
