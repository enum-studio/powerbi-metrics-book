"""Keep the sample documentation the answer must use outside the agent's folder."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import pbmb_json, save_state

metric = pbmb_json("metrics", "show", "net_sales")
save_state(
    {
        "owner_team": metric["owner_team"],
        "moves_with": [link["metric"]["name"] for link in metric["moves_with"]],
    }
)
