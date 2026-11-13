"""Asks the open question about orders that the task is to answer."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import metrics_by_name, pbmb_json, save_state

orders = metrics_by_name()["orders"]["id"]
asked = pbmb_json(
    "questions",
    "ask",
    "metric",
    orders,
    "--title",
    "Do the orders include returned orders?",
    "--body",
    "Finance and sales get different numbers. Does Orders count the orders "
    "that were later returned?",
)
save_state({"thread": asked["id"]})
