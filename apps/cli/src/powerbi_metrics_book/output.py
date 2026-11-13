"""What every command prints, and how a failed one ends.

A command opens a session, asks the client, and hands the answer to `emit`:
with --json that is one JSON document on stdout and nothing else, without it
a short answer made with rich. A failure is one sentence on stderr and an exit
code: 1 failed, 2 usage (Typer's own), 3 not signed in, 4 refused or not
found, 5 rate limited.
"""

import json
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import plain
from powerbi_metrics_book.client import (
    ApiError,
    Client,
    Json,
    NotSignedInError,
    UnreachableError,
)
from powerbi_metrics_book.credentials import CredentialsError

FAILED = 1
NOT_SIGNED_IN = 3
REFUSED_OR_NOT_FOUND = 4
RATE_LIMITED = 5

_EXIT_CODE_BY_KIND = {
    "unauthenticated": NOT_SIGNED_IN,
    "refused": REFUSED_OR_NOT_FOUND,
    "not_found": REFUSED_OR_NOT_FOUND,
    "rate_limited": RATE_LIMITED,
}

JsonOption = Annotated[
    bool, typer.Option("--json", help="Print one JSON document and nothing else.")
]


@dataclass(frozen=True)
class Settings:
    """The options of `pbmb` itself, which every command inherits."""

    url: str | None = None
    as_json: bool = False


@dataclass(frozen=True)
class Session:
    client: Client
    as_json: bool

    def emit(self, document: Json, render: Callable[[Console], None]) -> None:
        if self.as_json:
            typer.echo(json.dumps(document, indent=2))
        else:
            render(Console())


def exit_code(error: Exception) -> int:
    if isinstance(error, NotSignedInError):
        return NOT_SIGNED_IN
    if isinstance(error, ApiError):
        return _EXIT_CODE_BY_KIND.get(error.kind, FAILED)
    return FAILED


@contextmanager
def open_session(context: typer.Context, json_output: bool) -> Iterator[Session]:
    """A client for the deployment and credentials the command line names.

    --json is read from `pbmb --json <command>` and from `<command> --json`.
    A failure inside the block ends the command with its sentence and code.
    """
    settings = context.ensure_object(Settings)
    try:
        with closing(Client(settings.url)) as client:
            yield Session(client, settings.as_json or json_output)
    except (
        ApiError,
        NotSignedInError,
        UnreachableError,
        CredentialsError,
    ) as error:
        typer.echo(plain(str(error)), err=True)
        raise typer.Exit(exit_code(error)) from error
