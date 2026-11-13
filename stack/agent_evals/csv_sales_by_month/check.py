"""Passes when the agent left a CSV of last year's net sales by month that holds
the right figure for each month (one extra row labelled Total is allowed), and
the query log shows it took the metric's measure, not its own."""

import csv
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import WORKDIR, fail, pbmb_json

SALES = "Sales"
MEASURE = "Net sales"
# The query the mock answers for 2025 (SAMPLE_QUERIES.net_sales_by_month_2025
# in packages/powerbi-mock/src/sample/tenant.ts); the mock evaluates no other
# measure query, so the figures it gives are the truth for the check.
DAX = """EVALUATE
SUMMARIZECOLUMNS(
    'Date'[Month],
    TREATAS({2025}, 'Date'[Year]),
    "Net sales", [Net sales]
)
ORDER BY 'Date'[Month]"""
# A month is right to the cent: rounding money to whole units is a wrong answer.
TOLERANCE = 0.01


def numeric_columns(path: Path) -> list[tuple[list[float], float | None]]:
    """Each fully numeric column as its month figures and the Total row's figure.

    A row whose first cell is "Total", in any case, is not a month; there may
    be one.
    """
    with path.open(newline="") as file:
        rows = [row for row in list(csv.reader(file))[1:] if row]
    totals = [row for row in rows if row[0].strip().lower() == "total"]
    months = [row for row in rows if row not in totals]
    if len(totals) > 1:
        return []
    columns = []
    for column in range(max((len(row) for row in months), default=0)):
        try:
            figures = [float(row[column]) for row in months]
            total = float(totals[0][column]) if len(totals) == 1 else None
        except (ValueError, IndexError):
            continue
        columns.append((figures, total))
    return columns


def matches(found: list[float], total: float | None, expected: list[float]) -> bool:
    if len(found) != len(expected):
        return False
    # The rows are the months in calendar order, as the mock's query gives them.
    pairs = zip(found, expected, strict=True)
    if any(abs(a - b) >= TOLERANCE for a, b in pairs):
        return False
    return total is None or abs(total - sum(expected)) < TOLERANCE


def describe(path: Path, found: list[float], expected: list[float]) -> str:
    if len(found) == len(expected) and matches(sorted(found), None, sorted(expected)):
        return f"{path.name} has the right figures, not in calendar month order"
    difference = sum(found) - sum(expected)
    return (
        f"{path.name} has {len(found)} rows summing to {sum(found):.2f}, "
        f"{difference:+.2f} from {sum(expected):.2f}"
    )


files = sorted(WORKDIR.rglob("*.csv"))
if not files:
    fail("no CSV file was left in the working folder")
if int(os.environ.get("PBMB_EVAL_YEAR", date.today().year)) != 2026:
    fail("the mock answers 2025 only, which is last year only in 2026")

logged = pbmb_json(
    "queries", "search", MEASURE, "--dataset", SALES, "--mine", "--status", "succeeded"
)["items"]
used = [
    each
    for each in logged
    if (each.get("dataset") or {}).get("name") == SALES
    and MEASURE in (each.get("measure_names") or [])
    and each.get("metric_ids")
]
expected_answer = pbmb_json(
    "dax",
    "run",
    SALES,
    "--query",
    DAX,
    "--preview",
    "100",
    "--purpose",
    "Agent eval check: the figures a correct answer has",
)
expected = [row[1] for row in expected_answer["preview"]]

if not any(
    matches(found, total, expected)
    for path in files
    for found, total in numeric_columns(path)
):
    seen = "; ".join(
        describe(path, found, expected)
        for path in files
        for found, _total in numeric_columns(path)
    )
    fail(
        f"no numeric column holds the {len(expected)} monthly net sales "
        f"({seen or 'no numeric column'})"
    )
if not used:
    fail(f"the query log has no successful {SALES} query using [{MEASURE}]")
