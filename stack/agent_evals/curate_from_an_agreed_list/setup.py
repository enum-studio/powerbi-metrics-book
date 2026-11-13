"""Remembers each metric's key and summary, and the category paths, so the check
can tell what the agent changed."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import category_paths, pbmb_json, save_state

save_state(
    {
        "metrics": {
            each["id"]: each
            for each in pbmb_json("metrics", "list", "--limit", "500")["items"]
        },
        "categories": category_paths(),
    }
)
