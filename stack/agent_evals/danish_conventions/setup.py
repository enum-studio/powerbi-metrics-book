"""Gives the book four metrics named the Danish way, with spaces. Three are
described in full, so only their names stand in the way of the checks; the
fourth is described in nothing, so a rule about fields must keep failing."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, metrics_by_name, pbmb, pbmb_json, save_state

CATEGORY = "salg"
# Draft key: its Danish name, unit and definition.
DESCRIBED = {
    "net_sales": ("Omsætning netto", "money", "Salg efter rabatter, før returer."),
    "orders": ("Antal ordrer", "count", "Antal forskellige ordrer."),
    "units_sold": ("Antal solgte enheder", "quantity", "Summen af solgte enheder."),
}
UNDESCRIBED = {"average_order_value": "Gennemsnitlig ordreværdi"}

pbmb("categories", "create", CATEGORY)
drafts = metrics_by_name()
ids = {key: drafts[key]["id"] for key in [*DESCRIBED, *UNDESCRIBED]}
for key, (danish, unit, definition) in DESCRIBED.items():
    pbmb("metrics", "rename", key, danish)
    pbmb(
        "metrics",
        "update",
        danish,
        "--definition",
        definition,
        "--unit",
        unit,
        "--category",
        CATEGORY,
        "--aliases",
        "none",
        "--not-the-same-as",
        "none",
        "--when-to-use",
        "Til tal i rapporter.",
        "--grain",
        "Pr. ordrelinje.",
    )
for key, danish in UNDESCRIBED.items():
    pbmb("metrics", "rename", key, danish)

checked = pbmb_json("metrics", "check", "--all", ok=(0, 1))["metrics"]
names = {danish for danish, _unit, _definition in DESCRIBED.values()}
failing = {
    each["name"]
    for each in checked
    if each["name"] in names and any(not found["passed"] for found in each["checks"])
}
if failing != names:
    fail(f"the default conventions should fail all the Danish names; failing {failing}")
save_state(
    {
        "described": [ids[key] for key in DESCRIBED],
        "undescribed": [ids[key] for key in UNDESCRIBED],
    }
)
