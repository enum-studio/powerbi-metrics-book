import os
from typing import NoReturn

import typer
from rich.text import Text

from powerbi_metrics_book import credentials
from powerbi_metrics_book.answers import one_line, plain
from powerbi_metrics_book.calls import revoke_cli_grants
from powerbi_metrics_book.client import ApiError, NotSignedInError, UnreachableError
from powerbi_metrics_book.credentials import CredentialsError
from powerbi_metrics_book.output import JsonOption, Settings, open_session


def command(context: typer.Context, json_output: JsonOption = False) -> None:
    """Sign out: revoke the login at the deployment and delete it from this machine.

    Example: pbmb logout

    The deployment keeps one CLI grant per person, so this also ends the login
    on every other machine you signed in on; they run `pbmb login` again. The
    saved login is deleted here even when the deployment cannot be reached.
    """
    if os.environ.get("PBMB_API_KEY"):
        raise typer.BadParameter(
            "PBMB_API_KEY is set, so this would ask as the key, not as your "
            "saved login. Unset it first."
        )
    try:
        credentials.load()
    except CredentialsError:
        _delete_unreadable_login(context)
    with open_session(context, json_output) as session:
        url = session.client.url
        revoked = 0
        try:
            revoked = revoke_cli_grants(session.client)
        except NotSignedInError:
            # The deployment already refuses this login: nothing is left to revoke.
            pass
        except ApiError as error:
            raise ApiError(
                error.kind, _not_revoked(url, error), error.status
            ) from error
        except UnreachableError as error:
            raise UnreachableError(_not_revoked(url, error)) from error
        finally:
            credentials.delete()
        session.emit(
            {"signed_out": True, "revoked_grants": revoked},
            lambda console: console.print(Text(plain(f"Signed out of {url}."))),
        )


def _not_revoked(url: str, error: Exception) -> str:
    return (
        f"Deleted the saved login here, but {url} did not revoke it: "
        f"{one_line(str(error)).rstrip('.')}. Revoke it at {url}/settings/connections."
    )


def _delete_unreadable_login(context: typer.Context) -> NoReturn:
    """The file cannot be trusted (it is readable by others, or not ours), so
    it is deleted unread, and the person is told where to revoke the grant."""
    credentials.delete()
    url = context.ensure_object(Settings).url or os.environ.get("PBMB_URL")
    where = (
        f"{url.rstrip('/')}/settings/connections"
        if url
        else "your deployment's /settings/connections page"
    )
    typer.echo(
        plain(
            "Deleted the saved login here, but could not read it to revoke it. "
            f"Revoke it at {where}."
        ),
        err=True,
    )
    raise typer.Exit(1)
