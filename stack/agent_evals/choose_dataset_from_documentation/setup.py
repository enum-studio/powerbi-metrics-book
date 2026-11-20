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
    "Sales": "Use for ecommerce reporting: purchases made through the website. "
    "Filter Channel to Web. For purchases taken at a shop counter, use Retail.",
    "Retail": "Use for purchases taken at a shop counter, with each location's stock. "
    "For purchases made through the website, use Sales.",
}.items():
    pbmb("docs", "set", "dataset", by_name[name], "--when-to-use", when_to_use)
save_state({"dataset": "Sales", "reason_word": "ecommerce"})
