import typer
from rich.console import Console

from powerbi_metrics_book.client import ApiError, Json
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import line, print_fields

SAMPLE_TENANT = "the sample tenant: invented data, not your company's"


def _for_people(me: dict[str, Json]) -> dict[str, Json]:
    """The answer for a terminal: on the sample tenant, a Tenant line says so
    in place of the raw sample_data field."""
    if me.get("sample_data") is not True:
        return me
    shown = {name: value for name, value in me.items() if name != "sample_data"}
    return {**shown, "Tenant": SAMPLE_TENANT}


def _show_me(console: Console, me: dict[str, Json]) -> None:
    if "questions" in me:
        line(console, f"Questions: {'on' if me['questions'] else 'off'}")
    print_fields(
        console,
        _for_people({key: value for key, value in me.items() if key != "questions"}),
    )


def command(context: typer.Context, json_output: JsonOption = False) -> None:
    """Show who the deployment sees you as.

    Asks GET /api/v1/me: the person or service account, its roles and the state
    of the Power BI connection, and on the sample tenant a line saying so. It
    also shows whether questions are on, whether searches and requests are
    captured and their retention in days. It proves the address, your credentials
    and the api in one call, so it is the first thing to run after `pbmb login`.
    """
    with open_session(context, json_output) as session:
        me = session.client.get("/me")
        if not isinstance(me, dict):
            raise ApiError(
                "upstream", f"{session.client.url} did not answer who you are.", 200
            )
        session.emit(me, lambda console: _show_me(console, me))
