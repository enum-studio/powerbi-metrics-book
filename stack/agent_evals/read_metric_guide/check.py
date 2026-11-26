"""Require the documented equation, limitation, owner and real neighbors."""

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
state = load_state()
if not isinstance(answer, dict):
    fail("answer must be an object")
formula = answer.get("formula")
if not isinstance(formula, str) or not all(
    word in formula.lower() for word in ["orders", "average", "value"]
):
    fail("the formula does not name orders and average order value")
limitation = answer.get("dont_use_for")
if not isinstance(limitation, str) or "profit" not in limitation.lower():
    fail("the answer misses the documented distinction from profit")
if answer.get("owner_team") != state["owner_team"]:
    fail("the answer does not name the owning team")
related = answer.get("moves_with")
if (
    not isinstance(related, list)
    or len(set(related)) < 2
    or not all(name in state["moves_with"] for name in related)
):
    fail("the answer needs two distinct documented neighbors")
