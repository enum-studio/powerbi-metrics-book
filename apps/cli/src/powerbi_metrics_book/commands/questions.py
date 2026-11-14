from typing import Annotated

import typer
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import objects_in, query_of
from powerbi_metrics_book.calls import show_list, show_object
from powerbi_metrics_book.client import Json, api_path
from powerbi_metrics_book.output import JsonOption
from powerbi_metrics_book.tables import print_fields, print_table

app = typer.Typer(
    help="Ask questions and leave comments on anything in the book. "
    "An admin must turn questions on under Settings, General."
)

THREAD_COLUMNS = [
    "id",
    "kind",
    "status",
    "element.kind",
    "element.id",
    "reply_count",
    "upvote_count",
    "title",
]
REPLY_COLUMNS = ["id", "author.id", "created_at", "accepted", "body"]
ElementKind = Annotated[
    str,
    typer.Argument(
        help="What it is about: workspace, dataset, table, column, measure, "
        "metric, variant, term, category or query."
    ),
]
ElementId = Annotated[str, typer.Argument(help="The element's id.")]
ThreadId = Annotated[str, typer.Argument(metavar="THREAD", help="The thread id.")]
BodyOption = Annotated[str, typer.Option(help="Plain text or Markdown.")]


def _show_thread(console: Console, thread: dict[str, Json]) -> None:
    print_fields(
        console, {name: value for name, value in thread.items() if name != "replies"}
    )
    if thread.get("replies"):
        console.print(Text("\nReplies"))
        print_table(console, objects_in(thread, "replies"), REPLY_COLUMNS)


def _post(
    context: typer.Context,
    json_output: bool,
    kind: str,
    element_kind: str,
    element_id: str,
    title: str | None,
    body: str,
) -> None:
    sent: dict[str, Json] = {
        "kind": kind,
        "element": {"kind": element_kind, "id": element_id},
        "body": body,
    }
    if title is not None:
        sent["title"] = title
    show_object(context, json_output, "POST", "/threads", kind, body=sent)


@app.command("list")
def list_threads(
    context: typer.Context,
    mine: Annotated[bool, typer.Option("--mine", help="Only your own.")] = False,
    status: Annotated[
        str | None, typer.Option(help="open, answered or archived.")
    ] = None,
    element: Annotated[
        str | None,
        typer.Option(
            help="Only about this element, written kind:id, such as "
            "metric:7c9e6679-7425-40de-944b-e07fc1f90ae7."
        ),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List questions and comments, newest first."""
    element_kind, element_id = None, None
    if element is not None:
        element_kind, separator, element_id = element.partition(":")
        if not separator or not element_id:
            raise typer.BadParameter(
                "Write the element as kind:id.", param_hint="--element"
            )
    show_list(
        context,
        json_output,
        "/threads",
        "items",
        THREAD_COLUMNS,
        "the threads",
        query=query_of(
            mine=True if mine else None,
            status=status,
            element_kind=element_kind,
            element_id=element_id,
        ),
    )


@app.command("show")
def show(
    context: typer.Context, thread_id: ThreadId, json_output: JsonOption = False
) -> None:
    """Show a thread with its replies. Viewing it marks its replies as read."""
    show_object(
        context,
        json_output,
        "GET",
        api_path("threads", thread_id),
        "the thread",
        render=_show_thread,
    )


@app.command("ask")
def ask(
    context: typer.Context,
    kind: ElementKind,
    element_id: ElementId,
    title: Annotated[str, typer.Option(help="The question in one line.")],
    body: BodyOption,
    json_output: JsonOption = False,
) -> None:
    """Ask a question about an element, such as a metric or a column.

    People who curate the book see it and can answer. The element's `get`
    answers carry the accepted answers, so the next person finds them.
    """
    _post(context, json_output, "question", kind, element_id, title, body)


@app.command("comment")
def comment(
    context: typer.Context,
    kind: ElementKind,
    element_id: ElementId,
    body: BodyOption,
    json_output: JsonOption = False,
) -> None:
    """Leave a comment on an element. A comment has no title and takes replies."""
    _post(context, json_output, "comment", kind, element_id, None, body)


@app.command("reply")
def reply(
    context: typer.Context,
    thread_id: ThreadId,
    body: BodyOption,
    json_output: JsonOption = False,
) -> None:
    """Reply to a question or a comment."""
    show_object(
        context,
        json_output,
        "POST",
        api_path("threads", thread_id, "replies"),
        "the reply",
        body={"body": body},
    )


@app.command("accept")
def accept(
    context: typer.Context,
    thread_id: ThreadId,
    reply_id: Annotated[
        str, typer.Argument(metavar="REPLY", help="The reply that answers it.")
    ],
    json_output: JsonOption = False,
) -> None:
    """Accept a reply as the answer, which marks the question answered.

    The person who asked can accept; so can a curator.
    """
    show_object(
        context,
        json_output,
        "POST",
        api_path("threads", thread_id, "accept"),
        "the question",
        body={"reply_id": reply_id},
    )


@app.command("archive")
def archive(
    context: typer.Context, thread_id: ThreadId, json_output: JsonOption = False
) -> None:
    """Archive a thread. It leaves the default lists and search but is kept."""
    show_object(
        context,
        json_output,
        "POST",
        api_path("threads", thread_id, "archive"),
        "the question",
    )


@app.command("upvote")
def upvote(
    context: typer.Context,
    thread_id: ThreadId,
    remove: Annotated[
        bool, typer.Option("--remove", help="Take your upvote back.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Upvote a question you want answered. You have one upvote per question."""
    show_object(
        context,
        json_output,
        "DELETE" if remove else "PUT",
        api_path("threads", thread_id, "upvote"),
        "the upvote",
    )
