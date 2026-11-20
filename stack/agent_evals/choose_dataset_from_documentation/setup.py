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
    "Retail": "Use for shop stock and budget. Order lines arrive here only on Mondays, "
    "so for shop purchases since the last Monday, use Sales.",
    "Sales": "Use for orders from every channel. "
    "Shop purchases are the rows where Channel is Store.",
}.items():
    pbmb("docs", "set", "dataset", by_name[name], "--when-to-use", when_to_use)
save_state({"dataset": "Sales", "reason_word": "Monday"})
