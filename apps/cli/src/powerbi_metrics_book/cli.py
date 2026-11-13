"""The pbmb command: each module in powerbi_metrics_book.commands, registered
under its name."""

import importlib
import pkgutil
from types import ModuleType
from typing import Annotated

import typer

from powerbi_metrics_book import commands
from powerbi_metrics_book.output import JsonOption, Settings


class CommandModuleError(Exception):
    pass


def build_app(package: ModuleType = commands) -> typer.Typer:
    """Registers each module of package: `app` makes a group, `command` one command.

    A module that defines neither, or both, stops start-up, so a mistake in
    one command cannot go unnoticed until someone runs it.
    """
    # A traceback prints each frame's local variables, which hold tokens.
    app = typer.Typer(
        no_args_is_help=True, add_completion=False, pretty_exceptions_show_locals=False
    )

    # Without a callback Typer makes the only command the whole of `pbmb`.
    @app.callback()
    def main(
        context: typer.Context,
        url: Annotated[
            str | None,
            typer.Option(
                "--url",
                help="The deployment, such as https://book.example.com. "
                "Else PBMB_URL, else the one you signed in to.",
            ),
        ] = None,
        json_output: JsonOption = False,
    ) -> None:
        """Power BI Metrics Book: find, define and query metrics from the terminal.

        Sign in with `pbmb login`, or set PBMB_API_KEY. Every command takes --json.
        """
        context.obj = Settings(url=url, as_json=json_output)

    for discovered in sorted(
        pkgutil.iter_modules(package.__path__), key=lambda found: found.name
    ):
        qualified_name = f"{package.__name__}.{discovered.name}"
        module = importlib.import_module(qualified_name)
        group = getattr(module, "app", None)
        single = getattr(module, "command", None)
        if group is not None and single is not None:
            raise CommandModuleError(
                f"{qualified_name} defines both `app` and `command`; "
                "a module is one or the other"
            )
        if group is not None:
            app.add_typer(group, name=discovered.name)
        elif single is not None:
            app.command(name=discovered.name)(single)
        else:
            raise CommandModuleError(
                f"{qualified_name} defines neither `app` (a command group) "
                "nor `command` (a single command)"
            )
    return app


app = build_app()
