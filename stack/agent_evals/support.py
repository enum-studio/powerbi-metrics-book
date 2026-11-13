"""What the eval tasks' setup.py and check.py share.

`pbmb agents eval` runs them with PBMB_URL and XDG_CONFIG_HOME set, so `pbmb`
is signed in as the sample admin on the dev stack, and with PBMB_EVAL_WORKDIR
(the folder the agent works in) and PBMB_EVAL_STATE (a JSON file outside it,
where setup.py leaves what check.py needs).
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, NoReturn

STATE = Path(os.environ.get("PBMB_EVAL_STATE", "state.json"))
WORKDIR = Path(os.environ.get("PBMB_EVAL_WORKDIR", "."))


def pbmb(
    *words: str, ok: tuple[int, ...] = (0,), env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Runs `pbmb`; stops with pbmb's own words unless its exit code is in ok.

    env replaces the environment, to run as someone else than the eval's person.
    """
    result = subprocess.run(
        ["pbmb", *words],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env=env,
    )
    if result.returncode not in ok:
        said = " ".join((result.stdout + " " + result.stderr).split())
        fail(f"pbmb {' '.join(words[:4])} exited {result.returncode}: {said[:300]}")
    return result


def pbmb_json(*words: str, ok: tuple[int, ...] = (0,)) -> Any:
    return json.loads(pbmb("--json", *words, ok=ok).stdout)


def metrics_by_name() -> dict[str, dict[str, Any]]:
    return {each["name"]: each for each in pbmb_json("metrics", "list")["items"]}


def category_paths() -> list[str]:
    """Every category's path, sorted. Filing a metric leaves it unchanged."""
    found: list[str] = []
    waiting = pbmb_json("categories", "tree")
    while waiting:
        node = waiting.pop()
        found.append(node["path"])
        waiting += node["children"]
    return sorted(found)


def fail(why: str) -> NoReturn:
    """Prints why and exits 1; `pbmb agents eval` records it as the run's reason."""
    print(why)
    sys.exit(1)


def save_state(state: dict[str, Any]) -> None:
    STATE.write_text(json.dumps(state))


def load_state() -> dict[str, Any]:
    state: dict[str, Any] = json.loads(STATE.read_text())
    return state
