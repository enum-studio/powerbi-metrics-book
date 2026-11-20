"""The shape most remote commands share: call one route, show the answer.

    show_object(context, json_output, "GET", api_path("queries", id), "the query")
    show_list(context, json_output, "/admin/roles", "roles", COLUMNS, "the roles")

A command that does more opens `open_session` itself.
"""

import re
from collections.abc import Callable, Iterator, Sequence

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import (
    dig,
    object_of,
    objects_in,
    one_line,
    plain,
    query_of,
    string_field,
)
from powerbi_metrics_book.client import ApiError, Client, Json, Query, api_path
from powerbi_metrics_book.credentials import CLIENT_ID
from powerbi_metrics_book.output import open_session
from powerbi_metrics_book.tables import print_fields, print_table


def show_object(
    context: typer.Context,
    json_output: bool,
    method: str,
    path: str,
    what: str,
    *,
    query: Query | None = None,
    body: Json = None,
    render: Callable[[Console, dict[str, Json]], None] | None = None,
) -> dict[str, Json]:
    """Calls the route and prints the answer object (as fields unless render
    is given). Returns it."""
    with open_session(context, json_output) as session:
        answer = object_of(
            session.client.request(method, path, query=query, body=body), what
        )
        session.emit(answer, lambda console: (render or print_fields)(console, answer))
    return answer


def show_list(
    context: typer.Context,
    json_output: bool,
    path: str,
    key: str,
    columns: Sequence[str],
    what: str,
    *,
    query: Query | None = None,
) -> None:
    """GETs the route and prints answer[key], an array of objects, as a table."""
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get(path, query), what)
        session.emit(
            answer,
            lambda console: print_table(console, objects_in(answer, key), columns),
        )


def show_done(
    context: typer.Context,
    json_output: bool,
    method: str,
    path: str,
    document: dict[str, Json],
    sentence: str,
) -> None:
    """Calls a route that answers 204 and prints `document` or the sentence."""
    with open_session(context, json_output) as session:
        session.client.request(method, path)
        session.emit(document, lambda console: console.print(Text(plain(sentence))))


# More pages than a person has datasets: the api is not coming to an end.
MAX_PAGES = 100


def every_page(
    client: Client, path: str, query: Query, what: str
) -> Iterator[dict[str, Json]]:
    """Each page of a list route, `next_cursor` followed to the last one.

    A cursor the api repeats, or more than MAX_PAGES pages, is the api's
    error: it is not coming to an end.
    """
    cursor: str | None = None
    seen: set[str] = set()
    for _ in range(MAX_PAGES):
        page = object_of(client.get(path, {**query, **query_of(cursor=cursor)}), what)
        yield page
        following = page.get("next_cursor")
        if not isinstance(following, str):
            return
        if following in seen:
            raise ApiError(
                "upstream",
                f"The api's {what} did not come to an end: it repeated a cursor.",
                200,
            )
        seen.add(following)
        cursor = following
    raise ApiError(
        "upstream",
        f"The api's {what} did not come to an end after {MAX_PAGES} pages.",
        200,
    )


def every_metric(client: Client) -> list[dict[str, Json]]:
    """Every metric the caller may see, each page followed to the end."""
    return [
        metric
        for page in every_page(client, "/metrics", query_of(limit=500), "metrics")
        for metric in objects_in(page, "items")
    ]


# The shape the api's dataset routes accept as an id.
GUID = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def dataset_id(client: Client, reference: str) -> str:
    """The id of the dataset a person named by id or by exact name.

    The api's dataset routes take an id only, so a name is looked up through
    the list. A name is sent as a query value, never as part of a path. A name
    that is not found is a not_found error (exit 4); one that two datasets
    share is a usage error (exit 2) that lists their ids.
    """
    if GUID.fullmatch(reference):
        return reference
    found = [
        dataset
        for page in every_page(
            client,
            "/datasets",
            query_of(name_prefix=reference, limit=500),
            "list of datasets",
        )
        for dataset in objects_in(page, "items")
        if dataset.get("name") == reference
    ]
    if not found:
        raise ApiError(
            "not_found",
            f"No dataset named {one_line(reference)} that you may describe. "
            "Run `pbmb datasets list` to see them.",
            404,
        )
    if len(found) > 1:
        which = ", ".join(
            f"{one_line(string_field(dataset, 'id'))} "
            f"(workspace {one_line(dig(dataset, 'workspace.name'))})"
            for dataset in found
        )
        raise typer.BadParameter(
            f"Several datasets are named {one_line(reference)}. "
            f"Use the id of one: {which}."
        )
    return string_field(found[0], "id")


def revoke_cli_grants(client: Client) -> int:
    """Ends the CLI's grant, and how many were ended.

    The deployment keeps one per person, so this ends the login on every
    machine the person signed in on.
    """
    grants = objects_in(client.get("/me/grants"), "grants")
    ids = [
        string_field(grant, "id")
        for grant in grants
        if grant.get("client_id") == CLIENT_ID
    ]
    for grant_id in ids:
        client.request(
            "DELETE", api_path("me", "grants", grant_id, answered_by_api=True)
        )
    return len(ids)
