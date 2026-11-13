---
title: The change feed
description: Read what changed in the book by id, follow it with a service account, and write a short script that never misses an event.
sidebar:
  order: 6
---

The change feed tells your own tools what happened in the book: a metric was verified, a question was answered, a sync failed. You read it. The stack sends nothing to an address you type in, so there is no webhook to set up and no outbound call to trust.

The feed is one table, `event`. A row is written in the same database transaction as the change it describes, so an event exists if and only if the change does. Events are kept 90 days.

## Read it with the CLI

```bash
pbmb events --after 0 --kinds metric.verified,metric.approved
pbmb events --after 41 --follow --json
```

`pbmb events` prints what changed, oldest first, one line per event with its time, kind, element and id. `--after <id>` returns only events with a higher id. `--kinds` takes a comma-separated list. `--follow` keeps running and polls every 5 seconds, printing new events as they come, until you press Ctrl-C. With `--follow --json`, each event is one JSON line, so a script can read the output. To act on new events, keep the last id and pass it as `--after` next time. You see only the events about elements you may see.

## Read it over HTTP

For tools without the CLI, call the route. It takes the same `after` and `kinds`:

```bash
curl -s "$PBMB_URL/api/v1/events?after=0&limit=100" \
  -H "Authorization: Bearer $PBMB_API_KEY"
```

The answer is a JSON array, oldest first. Each event has:

| Field | Holds |
|---|---|
| `id` | A number that only goes up. |
| `at` | When it happened. |
| `kind` | One of the kinds below. |
| `element` | `{ "kind": "metric", "id": "..." }`, or `null` for a sync event. |
| `principal` | `{ "kind": "person" or "service_account", "id": "..." }`, or `null` for the sync. |
| `data` | A few facts about the change. |

Three query parameters: `after` (only events with a higher id; leave it out for all), `kinds` (a comma-separated list; leave it out for every kind), and `limit` (500 at most, which is also the default).

## The kinds

| Kind | When | `data` holds |
|---|---|---|
| `draft.created` | The sync made a draft metric. | `name`, `dismissed_reason` |
| `metric.created` | A curator created a metric. | `action`, `name`, `trust_state`, `dataset_ids` |
| `metric.changed` | A metric was updated, renamed, merged, dismissed or deleted. | the same, and `previous_name` after a rename |
| `metric.verified` | An agent verified a metric. | the same |
| `metric.approved` | A person approved a metric. | the same |
| `variant.moved` | A variant moved to another metric, or the sync filed one. | `measure_id`, `from_metric_id`, `to_metric_id`, `dataset_id` |
| `term.changed` | A term, or its columns or metrics, changed. | `action`, `name` |
| `conventions.changed` | The conventions were saved. | `version`, `paths` |
| `thread.created` | A question or comment was posted. | `thread_kind`, `element` |
| `thread.replied` | Someone replied. | |
| `thread.answered` | A reply was accepted. | |
| `thread.archived` | A curator archived a thread. | |
| `sync.finished` | A sync ended well. | `sync_run_id`, `kind`, `trigger`, `counts` |
| `sync.failed` | A sync ended badly. | the same, and `error` |

An event names its element by id and never carries another element's name, because the reader may see one metric and not the other. Ask for the element when you need its text.

## Who sees which event

You see an event when you may see its element. A metric event follows the datasets the metric's variants were in when it happened. A thread event follows the thread's element. Term and conventions events are visible to everyone signed in. Sync events are shown only to someone who holds the admin action `read_sync_events` (an admin person by default), and their `error` only to someone who may manage settings. A service account sees events for what its grant reaches, and no sync events.

An event you may not see is left out, so ids you receive can skip numbers. That is normal. Keep the last id you got.

## Follow it with a service account

A script needs its own identity, not a person's login. Make a service account that can read what the script should react to:

```bash
pbmb sa create metric-follower --owner data-team@sample.example --role viewer --workspace <workspace id>
pbmb sa keys create metric-follower
```

The key prints once. Put it where the script reads it, as `PBMB_API_KEY`, and never paste it into a chat. [Building on the API](/docs/make-it-yours/building-on-the-api/) has more on service accounts.

## A script that never misses an event

The feed is read by id, oldest first, and an id never becomes visible before a lower one. A reader that remembers the last id it handled and asks for what came after cannot miss an event. The script below saves the id after it handles each event. If it stops at any point, it starts again from the saved id. It may handle one event twice after a crash, so `handle` should be safe to repeat.

```python
#!/usr/bin/env python3
"""Print each metric event once, in order. Stop and start it as you like."""
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ["PBMB_URL"].rstrip("/")
KEY = os.environ["PBMB_API_KEY"]
KINDS = "metric.created,metric.changed,metric.verified,metric.approved"
PAGE = 100
CURSOR = Path("last_event_id")


def read_after(last_id: int) -> list[dict]:
    query = urllib.parse.urlencode({"after": last_id, "kinds": KINDS, "limit": PAGE})
    request = urllib.request.Request(
        f"{BASE}/api/v1/events?{query}",
        headers={"Authorization": f"Bearer {KEY}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def handle(event: dict) -> None:
    print(event["id"], event["kind"], event["data"].get("name"))


def save(last_id: int) -> None:
    temporary = CURSOR.with_suffix(".tmp")
    temporary.write_text(str(last_id))
    temporary.replace(CURSOR)


last_id = int(CURSOR.read_text()) if CURSOR.exists() else 0
while True:
    events = read_after(last_id)
    for event in events:
        handle(event)
        last_id = event["id"]
        save(last_id)
    if len(events) < PAGE:
        time.sleep(5)
```

Run it with `PBMB_URL` and `PBMB_API_KEY` set. An error, such as a revoked key, stops the script with the reason, and the saved id keeps its place. The first run reads everything from the last 90 days. To start from now, set `last_event_id` to the newest id first.

## Check

```bash
pbmb events --after 0 --kinds metric.verified
```

The command prints one line for each `metric.verified` event you may see, oldest first, or nothing when there are none. Note the id on the last line, say 41. Verify a metric (`pbmb metrics verify <name>`), then run `pbmb events --after 41 --kinds metric.verified`. It prints one line: the verification you just made, with the metric as its element.

Without the CLI, the same check over HTTP:

```bash
curl -s "$PBMB_URL/api/v1/events?kinds=metric.verified&after=41" -H "Authorization: Bearer $PBMB_API_KEY"
```

The answer is a JSON array holding that one event, with `element.id` set to the metric's id.
