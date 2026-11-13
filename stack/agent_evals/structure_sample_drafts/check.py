"""Passes when the two known merges are made (Revenue USD as the USD variant of
the metric that holds Revenue, which is net sales if the agent merged the two,
Ad spend LY as the previous-year variant of ad spend), the three calculations
that only look alike are still metrics of their own, and net sales, orders and
ad spend pass `pbmb metrics check` and are verified."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, load_state, pbmb_json

ids = load_state()
listed = {each["id"]: each for each in pbmb_json("metrics", "list")["items"]}

for merged in ("revenue_usd", "ad_spend_ly"):
    if ids[merged] in listed:
        fail(f"{merged} is still a metric of its own: it is a variant, so merge it")
for apart in ("web_net_sales_ly", "order_count", "revenue_in_selected_currency"):
    if ids[apart] not in listed:
        fail(f"{apart} is gone, but it is another calculation and not a variant")


def shifts(base: str) -> list[dict[str, str]]:
    if ids[base] not in listed:
        fail(f"{base} is gone from the book")
    shown = pbmb_json("metrics", "show", listed[ids[base]]["name"])
    return [each["shift"] for each in shown["other_variants"]]


holder = "revenue" if ids["revenue"] in listed else "net_sales"
if not any((shift["currency"] or "").upper() == "USD" for shift in shifts(holder)):
    fail(f"{holder} has no USD variant: Revenue USD was not filed under it")
if not any(
    shift["period"] == "previous_year" and shift["comparison"] == "none"
    for shift in shifts("ad_spend")
):
    fail("ad spend has no previous-year variant: Ad spend LY was not filed under it")

checked = {
    each["name"]: each["checks"]
    for each in pbmb_json("metrics", "check", "--all", ok=(0, 1))["metrics"]
}
for base in ("net_sales", "orders", "ad_spend"):
    metric = listed[ids[base]]
    if metric["trust_state"] not in ("agent_verified", "human_verified"):
        fail(f"{metric['name']} is {metric['trust_state']}, not verified")
    broken = [each["check"] for each in checked[metric["name"]] if not each["passed"]]
    if broken:
        fail(f"{metric['name']} fails {', '.join(broken)}")
