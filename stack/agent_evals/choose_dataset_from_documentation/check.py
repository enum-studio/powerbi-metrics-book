"""Passes only for the intended dataset and a reason about campaign spend."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import WORKDIR, fail, load_state

path = WORKDIR / "answer.json"
if not path.is_file():
    fail("no answer.json was left in the working folder")
try:
    answer = json.loads(path.read_text())
except json.JSONDecodeError:
    fail("answer.json is not JSON")
if not isinstance(answer, dict) or answer.get("dataset") != load_state()["dataset"]:
    fail("the answer does not choose the dataset whose documentation fits")
reason = answer.get("reason")
if not isinstance(reason, str) or not all(
    word in reason.lower() for word in ("campaign", "spend")
):
    fail("the reason does not explain the choice for campaign spend")
