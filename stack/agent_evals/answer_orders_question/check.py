"""Passes when the question is answered by an accepted reply that speaks of
returns (the book's DAX for Orders counts order ids and filters on nothing)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from support import fail, load_state, pbmb_json

thread = pbmb_json("questions", "show", load_state()["thread"])
if thread["status"] != "answered" or thread["accepted_reply_id"] is None:
    fail(f"the question is {thread['status']}, with {thread['reply_count']} replies")
accepted = [each for each in thread["replies"] if each["accepted"]]
if not accepted or "return" not in accepted[0]["body"].lower():
    fail("the accepted reply does not say anything about returns")
