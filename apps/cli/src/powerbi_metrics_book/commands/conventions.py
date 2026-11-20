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
from powerbi_metrics_book.conventions_file import (
    read_conventions as _read,
)
from powerbi_metrics_book.conventions_file import (
    read_mapping,
    write_conventions,
)
from powerbi_metrics_book.output import JsonOption, Session, open_session
from powerbi_metrics_book.tables import line, print_table

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
    any general naming advice. Each rule is listed by its id, with its value,
    whether the company set it (source company) or kept the preset's, and
    whether it is off. --json lists them under `rules`, and the rules no company
    can change, with why, under `fixed`.
    """
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/conventions"), "the conventions")
        summary = answer.get("summary")
        if not isinstance(summary, list):
            raise ApiError(
                "upstream", "The api did not answer a summary of the rules.", 200
            )
        listed = object_of(session.client.get("/conventions/rules"), "the rules")
        rules = objects_in(listed, "rules")
        shown: dict[str, Json] = {
            **answer,
            "rules": listed.get("rules"),
            "fixed": listed.get("fixed"),
        }

        def render(console: Console) -> None:
            line(console, string_field(answer, "guide"))
            line(console, "\nRules")
            for sentence in summary:
                line(console, f"- {one_line(sentence)}")
            line(console, "")
            print_table(console, rules, ["id", "value", "source", "off"])

        session.emit(shown, render)


@app.command("export")
def export(
    context: typer.Context,
    resolved: Annotated[
        bool, typer.Option("--resolved", help="Include preset values.")
    ] = False,
    output: Annotated[
        Path | None, typer.Option("--output", "-o", help="Write YAML here.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Export the company part, or the resolved conventions including the preset."""
    with open_session(context, json_output) as session:
        document = (
            _current(session.client)
            if resolved
            else object_of(
                session.client.get("/conventions/company"), "the company part"
            )
        )
        document = {"format": 1, **document}
        if output is not None:
            write_conventions(document, output, inline_guide=resolved)
        session.emit(
            document,
            lambda console: typer.echo(
                f"Wrote {output}."
                if output
                else yaml.safe_dump(document, sort_keys=False, allow_unicode=True),
                nl=output is not None,
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
        document = _read(file)
        current = object_of(
            session.client.get("/conventions/company"), "the company part"
        )
        listed = object_of(session.client.get("/conventions/rules"), "the rules")
        rule_ids = {string_field(item, "id") for item in objects_in(listed, "rules")}
        changes: list[Json] = []

        def compare(
            before: dict[str, Json], after: dict[str, Json], prefix: str = ""
        ) -> None:
            for key in sorted(before.keys() | after.keys()):
                left, right = before.get(key), after.get(key)
                path = f"{prefix}.{key}" if prefix else key
                if path not in rule_ids and (
                    isinstance(left, dict) or isinstance(right, dict)
                ):
                    compare(
                        left if isinstance(left, dict) else {},
                        right if isinstance(right, dict) else {},
                        path,
                    )
                elif left != right:
                    changes.append({"path": path, "before": left, "after": right})

        compare(current, document)
        difference: dict[str, Json] = {"changes": changes}
        session.emit(difference, lambda console: _print_changes(console, difference))
        if changes:
            raise typer.Exit(1)


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


def _rule_value(document: dict[str, Json], rule: str) -> Json:
    value: Json = document
    for key in rule.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _print_applied(
    console: Console, answer: dict[str, Json], document: dict[str, Json]
) -> None:
    rules = answer["changed_rules"]
    if not rules:
        line(console, "No change.")
    elif isinstance(rules, list):
        failing = object_of(answer["now_failing"], "the failing counts")
        for rule in rules:
            name = text_of(rule)
            line(
                console,
                f"{name}: {json.dumps(_rule_value(document, name))}; "
                f"{failing.get(name, 0)} targets now fail.",
            )
    added = objects_in(answer, "exceptions_added")
    if added:
        line(console, f"{len(added)} exceptions added.")
        line(console, yaml.safe_dump(added, sort_keys=False))


def _apply(
    session: Session, document: dict[str, Json], yes: bool, dry_run: bool = False
) -> dict[str, Json]:
    preview = object_of(
        session.client.request(
            "POST",
            "/conventions/apply",
            body={"conventions": document, "dry_run": True},
        ),
        "the apply result",
    )
    if dry_run or not preview["changed_rules"]:
        return preview
    if session.as_json and not yes:
        raise typer.BadParameter("--json cannot ask; add --yes.")
    if not session.as_json:
        _print_applied(Console(), preview, document)
    if not yes and not typer.confirm("Save these as the next version?", err=True):
        raise typer.Exit(1)
    return object_of(
        session.client.request(
            "POST",
            "/conventions/apply",
            body={"conventions": document, "dry_run": False},
        ),
        "the apply result",
    )


@app.command("apply")
def apply_file(
    context: typer.Context,
    file: FileArgument,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Preview without saving.")
    ] = False,
    baseline: Annotated[
        bool,
        typer.Option(
            "--baseline", help="Write exceptions for existing failures into the file."
        ),
    ] = False,
    reason: Annotated[
        str | None, typer.Option("--reason", help="Why existing failures are excepted.")
    ] = None,
    yes: Yes = False,
    json_output: JsonOption = False,
) -> None:
    """Apply a conventions file, showing changed rules and how many targets now fail."""
    if baseline and not reason:
        raise typer.BadParameter("--baseline requires --reason.")
    document = _read(file)
    with open_session(context, json_output) as session:
        if baseline:
            preview = object_of(
                session.client.request(
                    "POST",
                    "/conventions/apply",
                    body={
                        "conventions": document,
                        "dry_run": True,
                        "baseline_reason": reason,
                    },
                ),
                "the apply result",
            )
            if dry_run or not preview["changed_rules"]:
                session.emit(
                    preview, lambda console: _print_applied(console, preview, document)
                )
                return
            added = objects_in(preview, "exceptions_added")
            if added:
                from powerbi_metrics_book.conventions_file import add_exceptions

                document = add_exceptions(file, document, added)
        answer = _apply(session, document, yes, dry_run)
        if baseline:
            answer["exceptions_added"] = preview["exceptions_added"]
        session.emit(answer, lambda console: _print_applied(console, answer, document))


@app.command("import")
def import_file(
    context: typer.Context,
    file: FileArgument,
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    baseline: Annotated[bool, typer.Option("--baseline")] = False,
    reason: Annotated[str | None, typer.Option("--reason")] = None,
    yes: Yes = False,
    json_output: JsonOption = False,
) -> None:
    """Alias for apply for one release; use `pbmb conventions apply`."""
    typer.echo(
        "conventions import is an alias for apply for one release; "
        "use conventions apply.",
        err=True,
    )
    apply_file(context, file, dry_run, baseline, reason, yes, json_output)


@app.command("reset")
def reset(
    context: typer.Context,
    rule: Annotated[
        str | None, typer.Argument(help="Rule id to reset, or all company settings.")
    ] = None,
    yes: Yes = False,
    json_output: JsonOption = False,
) -> None:
    """Remove a company rule, its off entry and exceptions, then apply."""
    with open_session(context, json_output) as session:
        if rule is not None:
            rules = object_of(session.client.get("/conventions/rules"), "the rules")
            if rule not in [item["id"] for item in objects_in(rules, "rules")]:
                raise typer.BadParameter(f"Unknown rule id: {rule}.")
        document = object_of(
            session.client.get("/conventions/company"), "the company part"
        )
        if rule is None:
            document = {
                key: value
                for key, value in document.items()
                if key in ("format", "preset")
            }
        else:

            def remove(section: dict[str, Json], keys: list[str]) -> None:
                key = keys[0]
                if len(keys) == 1:
                    section.pop(key, None)
                elif isinstance(inner := section.get(key), dict):
                    remove(inner, keys[1:])
                    if not inner:
                        section.pop(key)

            remove(document, rule.split("."))
            if isinstance(off := document.get("off"), list):
                document["off"] = [item for item in off if item != rule]
            if "exceptions" in document:
                document["exceptions"] = [
                    item
                    for item in objects_in(document, "exceptions")
                    if item["rule"] != rule
                ]
        answer = _apply(session, document, yes)
        session.emit(answer, lambda console: _print_applied(console, answer, document))


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
            document = read_mapping(path)
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
