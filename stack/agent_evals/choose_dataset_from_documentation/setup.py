"""Gives two mock datasets different uses, without changing their model facts."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import pbmb, pbmb_json, save_state

by_name = {
    each["name"]: each["id"]
    for each in pbmb_json("datasets", "list", "--limit", "500")["items"]
}
for name, when_to_use in {
    "Sales": "Use for sales and returns by product and day. "
    "For campaign spend by month, use Marketing.",
    "Marketing": "Use for campaign spend by month and channel. "
    "For sales and returns, use Sales.",
}.items():
    pbmb("docs", "set", "dataset", by_name[name], "--when-to-use", when_to_use)
save_state({"dataset": "Marketing"})
