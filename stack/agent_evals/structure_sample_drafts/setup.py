"""Remembers the drafts the sync made by their ids, since the agent renames
metrics and the check must still find them."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, pbmb_json, save_state

NAMES = [
    "net_sales",
    "revenue",
    "orders",
    "ad_spend",
    "revenue_usd",
    "ad_spend_ly",
    "web_net_sales_ly",
    "order_count",
    "revenue_in_selected_currency",
]

drafts = {
    each["name"]: each["id"] for each in pbmb_json("drafts", "next", "--limit", "50")
}
missing = [name for name in NAMES if name not in drafts]
if missing:
    fail(f"the sync made no draft for {', '.join(missing)}")
save_state({name: drafts[name] for name in NAMES})
