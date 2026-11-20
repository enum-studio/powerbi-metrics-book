"""Passes only for the intended dataset and a reason drawn from when_to_use."""

import json
import re
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
state = load_state()
if not isinstance(answer, dict) or answer.get("dataset") != state["dataset"]:
    fail("the answer does not choose the dataset whose documentation fits")
reason = answer.get("reason")
if not isinstance(reason, str) or not re.search(
    rf"\b{re.escape(state['reason_word'])}", reason, re.IGNORECASE
):
    fail("the reason does not explain the documented use of this dataset")
