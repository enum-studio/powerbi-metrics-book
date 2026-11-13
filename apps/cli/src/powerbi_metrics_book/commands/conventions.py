import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Annotated

import typer
import yaml
from rich.console import Console

from powerbi_metrics_book.answers import (
    object_of,
    objects_in,
    one_line,
    string_field,
    text_of,
    typed_value,
)
from powerbi_metrics_book.client import ApiError, Client, Json
from powerbi_metrics_book.output import JsonOption, Session, open_session
from powerbi_metrics_book.tables import line

app = typer.Typer(
    help="The company's rules for names, descriptions, variants and verification."
)

# The two presets the api's conventions schema names (`preset`).
PRESETS = {
    "metrics_book": "Metrics Book's naming standard and its idea of metrics and "
    "variants. The default.",
    "minimal": "Asks only for a definition and a unit, checks no name, and still "
    "groups drafts by fingerprint. Start here for your own rules.",
}

# A conventions file is a few KiB; a larger one is not one.
MAX_FILE_BYTES = 1024 * 1024

FileArgument = Annotated[Path, typer.Argument(help="A conventions YAML file.")]
Yes = Annotated[bool, typer.Option("--yes", help="Save without asking.")]


def _has_terminal() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def _current(client: Client) -> dict[str, Json]:
    """The conventions in force as one document: preset, guide, then the rules."""
    answer = object_of(client.get("/conventions"), "the conventions")
    rules = object_of(answer.get("rules"), "the rules")
    return {
        "preset": answer.get("preset"),
        "guide": answer.get("guide"),
        **{name: value for name, value in rules.items() if name != "preset"},
    }


class _NoAliasLoader(yaml.SafeLoader):
    """SafeLoader without anchors and aliases, which can expand a small file
    into a huge document."""

    def compose_node(self, parent: yaml.Node | None, index: int) -> yaml.Node | None:
        if self.check_event(yaml.AliasEvent):
            raise yaml.YAMLError("aliases (*name) are not allowed")
        return super().compose_node(parent, index)


def _read(path: Path) -> dict[str, Json]:
    if not path.is_file():
        raise typer.BadParameter(f"{path} is not a regular file.")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise typer.BadParameter(f"{path} is over 1 MiB; it is not a conventions file.")
    try:
        document: Json = yaml.load(path.read_text(), Loader=_NoAliasLoader)
    except yaml.YAMLError as error:
        raise typer.BadParameter(f"{path} is not valid YAML: {error}") from error
    if not isinstance(document, dict):
        raise typer.BadParameter(f"{path} must hold one YAML mapping.")
    return document


def _changes(client: Client, document: dict[str, Json]) -> dict[str, Json]:
    """The api's difference: {"changes": [{path, before, after}]}."""
    answer = client.request("POST", "/conventions/diff", body=document)
    return object_of(answer, "the difference")


def _print_changes(console: Console, difference: dict[str, Json]) -> None:
    changes = objects_in(difference, "changes")
    if not changes:
        line(console, "No changes.")
    for change in changes:
        line(
            console,
            f"{one_line(change.get('path'))}: "
            f"{json.dumps(change.get('before'))} "
            f"-> {json.dumps(change.get('after'))}",
        )


def _save(session: Session, document: dict[str, Json]) -> None:
    answer = object_of(
        session.client.request("PUT", "/conventions", body=document), "the conventions"
    )

    def render(console: Console) -> None:
        line(console, f"Saved as version {text_of(answer.get('version'))}.")
        _print_changes(console, answer)

    session.emit(answer, render)


def _confirm_changes(
    session: Session,
    document: dict[str, Json],
    yes: bool,
) -> bool:
    """Shows what saving would change and asks; False when there is nothing
    to save. Refuses to ask when --json leaves nowhere to ask."""
    if session.as_json and not yes:
        raise typer.BadParameter("--json cannot ask; add --yes.", param_hint="--yes")
    difference = _changes(session.client, document)
    if not objects_in(difference, "changes"):
        session.emit(difference, lambda console: line(console, "No changes."))
        return False
    if not session.as_json:
        _print_changes(Console(), difference)
    if not yes and not typer.confirm("Save these as the next version?", err=True):
        typer.echo("Nothing was saved.", err=True)
        raise typer.Exit(1)
    return True


@app.command("show")
def show(context: typer.Context, json_output: JsonOption = False) -> None:
    """Show the conventions: the guide in the company's words, then the rules.

    Read this before you name, describe, group or verify anything. The checks
    (`pbmb metrics check`) read these rules, and the company's rules win over
    any general naming advice.
    """
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/conventions"), "the conventions")
        summary = answer.get("summary")
        if not isinstance(summary, list):
            raise ApiError(
                "upstream", "The api did not answer a summary of the rules.", 200
            )

        def render(console: Console) -> None:
            line(console, string_field(answer, "guide"))
            line(console, "\nRules")
            for sentence in summary:
                line(console, f"- {one_line(sentence)}")

        session.emit(answer, render)


@app.command("export")
def export(context: typer.Context, json_output: JsonOption = False) -> None:
    """Print the conventions in force as the YAML that `import` and `edit` take."""
    with open_session(context, json_output) as session:
        document = _current(session.client)
        session.emit(
            document,
            lambda console: typer.echo(
                yaml.safe_dump(document, sort_keys=False, allow_unicode=True), nl=False
            ),
        )


@app.command("presets")
def presets(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the presets the conventions can start from, and the one in force.

    Switch with `pbmb conventions set preset minimal`; the preset is the base
    that the rest of the document overrides. The list is fixed in the CLI: the
    two presets the conventions schema names.
    """
    with open_session(context, json_output) as session:
        current = _current(session.client).get("preset")
        listed: Json = {
            "current": current,
            "presets": [
                {"name": name, "description": description}
                for name, description in PRESETS.items()
            ],
        }

        def render(console: Console) -> None:
            for name, description in PRESETS.items():
                marker = " (in force)" if name == current else ""
                line(console, f"{name}{marker}: {description}")

        session.emit(listed, render)


@app.command("diff")
def diff(
    context: typer.Context, file: FileArgument, json_output: JsonOption = False
) -> None:
    """Show what a file would change against the conventions in force. Saves nothing."""
    with open_session(context, json_output) as session:
        difference = _changes(session.client, _read(file))
        session.emit(difference, lambda console: _print_changes(console, difference))


@app.command("validate")
def validate(
    context: typer.Context, file: FileArgument, json_output: JsonOption = False
) -> None:
    """Check a file against the conventions' schema. Saves nothing.

    Exits 1 with the api's sentence when the file is not valid.
    """
    with open_session(context, json_output) as session:
        difference = _changes(session.client, _read(file))
        count = len(objects_in(difference, "changes"))
        session.emit(
            {"valid": True, **difference},
            lambda console: line(
                console,
                f"{file} is valid. Saving it would change {count} rules.",
            ),
        )


@app.command("set")
def set_value(
    context: typer.Context,
    path: Annotated[
        str,
        typer.Argument(help="Where, dotted: naming.case or trust.human_verify_from."),
    ],
    value: Annotated[
        str,
        typer.Argument(
            help='The new value. JSON is read as JSON (true, 3, ["a", "b"]), '
            "anything else as text."
        ),
    ],
    json_output: JsonOption = False,
) -> None:
    """Change one rule and save the conventions as the next version.

    The api checks the whole document and refuses what is not valid. It only
    accepts a change to a trust.* rule from a person in the browser (admin
    section), so `set` cannot make one.
    """
    if path.startswith("trust."):
        typer.echo(
            "Note: the api only accepts changes to trust rules from a person in the "
            "browser (the admin section); this is likely to be refused.",
            err=True,
        )
    with open_session(context, json_output) as session:
        document = _current(session.client)
        *parents, last = path.split(".")
        section: dict[str, Json] = document
        for step in parents:
            inner = section.setdefault(step, {})
            if not isinstance(inner, dict):
                raise typer.BadParameter(f"{step} in {path} is a value, not a section.")
            section = inner
        section[last] = typed_value(value)
        _save(session, document)


@app.command("import")
def import_file(
    context: typer.Context,
    file: FileArgument,
    yes: Yes = False,
    json_output: JsonOption = False,
) -> None:
    """Replace the conventions with a file: show the difference, ask, then save.

    With --json you must pass --yes, since there is nowhere to ask. The file must
    be a regular YAML file under 1 MiB without aliases.
    """
    with open_session(context, json_output) as session:
        document = _read(file)
        if _confirm_changes(session, document, yes):
            _save(session, document)


class _EditorNotStartedError(Exception):
    pass


def _run_editor(command: list[str], editor: str, path: Path) -> None:
    try:
        status = subprocess.run([*command, str(path)], check=False)
    except OSError as error:
        raise _EditorNotStartedError(
            f"$EDITOR ({editor}) is not a command I can run: {error}."
        ) from error
    if status.returncode:
        typer.echo(f"{editor} exited with status {status.returncode}.", err=True)
        raise typer.Exit(1)


@app.command("edit")
def edit(context: typer.Context, json_output: JsonOption = False) -> None:
    """Open the conventions as YAML in $EDITOR, check them, show the difference,
    ask, then save them as the next version.

    Needs a terminal, so it cannot be used with --json. Your file is removed once
    it is saved. If the api refuses it, the save fails or you abort, the file is
    kept and its path printed, so nothing you wrote is lost.
    """
    editor = os.environ.get("EDITOR")
    if not _has_terminal() or not editor:
        typer.echo(
            "Editing needs a terminal and $EDITOR. Without them, run "
            "`pbmb conventions export`, change the file, then `pbmb conventions "
            "import <file>`.",
            err=True,
        )
        raise typer.Exit(2)
    with open_session(context, json_output) as session:
        if session.as_json:
            raise typer.BadParameter("edit is interactive and cannot print JSON.")
        try:
            command = shlex.split(editor)
        except ValueError as error:
            raise typer.BadParameter(
                f"$EDITOR ({editor}) is not a command I can run: {error}."
            ) from error
        current = _current(session.client)
        folder = Path(tempfile.mkdtemp(prefix="pbmb-conventions-"))
        path = folder / "conventions.yml"
        keep = True
        try:
            path.write_text(
                yaml.safe_dump(current, sort_keys=False, allow_unicode=True)
            )
            _run_editor(command, editor, path)
            document = _read(path)
            if _confirm_changes(session, document, yes=False):
                _save(session, document)
            keep = False
        except _EditorNotStartedError as error:
            keep = False
            raise typer.BadParameter(str(error)) from error
        finally:
            if keep:
                typer.echo(f"Your edits are kept at {path}.", err=True)
            else:
                shutil.rmtree(folder)
