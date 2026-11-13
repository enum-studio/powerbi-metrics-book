"""Passes when the saved conventions validate, every check passes on the three
Danish metrics that are described in full, and the rule about fields still
fails the one that is described in nothing (so the checks were not switched
off to make the names pass)."""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, load_state, pbmb, pbmb_json

state = load_state()

with tempfile.TemporaryDirectory() as folder:
    saved = Path(folder) / "saved.yml"
    saved.write_text(pbmb("conventions", "export").stdout)
    pbmb("conventions", "validate", str(saved))

by_id = {each["id"]: each["name"] for each in pbmb_json("metrics", "list")["items"]}
checked = {
    each["name"]: each["checks"]
    for each in pbmb_json("metrics", "check", "--all", ok=(0, 1))["metrics"]
}


def failing(metric_id: str) -> list[str]:
    if metric_id not in by_id:
        fail(f"the metric {metric_id} is gone from the book")
    results = checked[by_id[metric_id]]
    return [found["check"] for found in results if not found["passed"]]


for metric_id in state["described"]:
    still = failing(metric_id)
    if still:
        fail(f"{by_id[metric_id]} still fails {', '.join(still)}")
for metric_id in state["undescribed"]:
    if not any(name.startswith("metric_fields") for name in failing(metric_id)):
        fail(f"{by_id[metric_id]} has no definition and the fields check lets it pass")
