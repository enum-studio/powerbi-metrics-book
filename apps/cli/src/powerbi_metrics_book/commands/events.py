import json
import time
from typing import Annotated

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import objects_of, plain, query_of, text_of
from powerbi_metrics_book.client import ApiError, Json
from powerbi_metrics_book.output import JsonOption, Session, open_session

POLL_SECONDS = 5
# Even after a full page, so a server that always answers a full page is not
# asked in a tight loop.
MIN_WAIT_SECONDS = 0.5
# How many events --follow asks for at once; a page this full means more wait.
PAGE_SIZE = 100


def command(
    context: typer.Context,
    after: Annotated[
        str | None, typer.Option(help="Only events after the one with this id.")
    ] = None,
    kinds: Annotated[
        str | None,
        typer.Option(help="Only these kinds of event, separated by commas."),
    ] = None,
    follow: Annotated[
        bool,
        typer.Option(
            "--follow",
            help="Keep running and print new events as they come, "
            "polling every 5 seconds. Stop with Ctrl-C.",
        ),
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Print what changed in the book, oldest first.

    Each event has an id, a time, a kind, the element it is about and its
    data; you see the events about elements you may see. To act on new events,
    keep the last id and pass it as --after next time, or use --follow. With
    --follow and --json, each event is one JSON line.
    """
    with open_session(context, json_output) as session:
        if follow:
            _follow(session, after, kinds)
            return
        answer = _fetch(session, after, kinds, None)
        events = objects_of(answer, "the events")
        session.emit(answer, lambda console: _print(console, events))


def _fetch(
    session: Session, after: str | None, kinds: str | None, limit: int | None
) -> Json:
    return session.client.get(
        "/events", query_of(after=after, kinds=kinds, limit=limit)
    )


def _line(event: dict[str, Json]) -> str:
    fields = (event.get(name) for name in ("at", "kind", "element", "id"))
    return plain("  ".join(text_of(field) for field in fields))


def _print(console: Console, events: list[dict[str, Json]]) -> None:
    for event in events:
        console.print(Text(_line(event)))


def _follow(session: Session, after: str | None, kinds: str | None) -> None:
    try:
        while True:
            events = objects_of(_fetch(session, after, kinds, PAGE_SIZE), "the events")
            for event in events:
                typer.echo(json.dumps(event) if session.as_json else _line(event))
            if events:
                last = events[-1].get("id")
                if not isinstance(last, str | int) or str(last) == after:
                    raise ApiError(
                        "upstream",
                        "The api's events have no new id to continue from, so "
                        "--follow stopped instead of repeating them.",
                        200,
                    )
                after = str(last)
            time.sleep(POLL_SECONDS if len(events) < PAGE_SIZE else MIN_WAIT_SECONDS)
    except KeyboardInterrupt:
        return
