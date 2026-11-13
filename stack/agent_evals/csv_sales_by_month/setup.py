"""Leaves a colleague's earlier question in the query log: the sample analyst
ran last year's net sales by month on the Sales dataset.

The mock answers a monthly sum only for one recorded query, so an agent can
reach the figure only by finding that query and running it again. The query
log shows every entry to everyone (access/policies/query_log.yaml), so the
agent finds the analyst's entry with `pbmb queries search`.
"""

import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx
import typer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, pbmb

from powerbi_metrics_book.commands.agents import answered, sign_in

ANALYST = {
    "email": "analyst@sample.example",
    "object_id": "a0000000-0000-4000-8000-000000000002",
}
SALES = "Sales"
PURPOSE = "Net sales by month for 2025"
# SAMPLE_QUERIES.net_sales_by_month_2025 in packages/powerbi-mock/src/sample/tenant.ts.
DAX = """EVALUATE
SUMMARIZECOLUMNS(
    'Date'[Month],
    TREATAS({2025}, 'Date'[Year]),
    "Net sales", [Net sales]
)
ORDER BY 'Date'[Month]"""


ADMIN_OBJECT_ID = "a0000000-0000-4000-8000-000000000001"


def act_as(mock: str, object_id: str) -> None:
    """Chooses who the mock's Microsoft signs in next (its control route)."""
    answered(httpx.post(f"{mock}/_mock/acting-user", json={"object_id": object_id}))


def connect_power_bi(url: str) -> None:
    """Connects the analyst's Power BI account, as the browser flow does: a
    query runs with the person's own Power BI token."""
    mock = f"http://127.0.0.1:{urlparse(url).port + 1}"
    with httpx.Client(base_url=url, timeout=30, follow_redirects=False) as http:
        signed = http.post(
            "/api/auth/dev/sign-in", json=ANALYST, headers={"origin": url}
        )
        answered(signed)
        cookie = "; ".join(
            line.split(";")[0] for line in signed.headers.get_list("set-cookie")
        )
        started = http.get("/api/v1/powerbi/connect?next=/", headers={"cookie": cookie})
        act_as(mock, ANALYST["object_id"])
        try:
            authorize = httpx.URL(started.headers["location"])
            if authorize.host.endswith(".localhost"):
                authorize = authorize.copy_with(host="127.0.0.1")
            back = httpx.get(authorize).headers["location"]
            done = http.get(back, headers={"cookie": cookie})
        finally:
            # The mock keeps the choice until someone else is chosen; leave it as
            # the dev stack's own setup does, on the admin.
            act_as(mock, ADMIN_OBJECT_ID)
        if done.status_code != 302:
            fail(
                f"connecting the analyst's Power BI account answered {done.status_code}"
            )


url = os.environ["PBMB_URL"]
try:
    # A new deployment gives nobody a role but its admin, who runs this.
    pbmb("admin", "roles", "assign", "viewer", "--person", ANALYST["email"])
    connect_power_bi(url)
    with tempfile.TemporaryDirectory() as config_home:
        sign_in(url, Path(config_home), ANALYST)
        pbmb(
            "dax",
            "run",
            SALES,
            "--query",
            DAX,
            "--purpose",
            PURPOSE,
            "--preview",
            "1",
            env={**os.environ, "XDG_CONFIG_HOME": config_home},
        )
except typer.BadParameter as error:
    fail(error.message)
