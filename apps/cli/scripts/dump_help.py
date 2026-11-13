"""Prints the CLI's own help as JSON: every command, its help, arguments and
options. The docs site renders it into reference/cli.md
(apps/docs/scripts/gen-reference.mjs).

    uv run python apps/cli/scripts/dump_help.py

Hidden commands and options are left out, as they are from `pbmb --help`.
Typer ships its own copy of click, so the walk reads Typer's classes and
imports click itself nowhere.
"""

import json
import sys
from typing import Any

import typer.main
from typer.core import TyperGroup, TyperOption

from powerbi_metrics_book.cli import app

# Every command has it, and `pbmb --help` says what it does.
IMPLICIT = {"help"}


def describe_parameter(parameter: Any) -> dict[str, Any]:
    is_option = isinstance(parameter, TyperOption)
    default = parameter.default
    choices = getattr(parameter.type, "choices", None)
    return {
        "kind": "option" if is_option else "argument",
        "name": parameter.name,
        "flags": [*parameter.opts, *parameter.secondary_opts]
        if is_option
        else [parameter.human_readable_name],
        "help": (getattr(parameter, "help", None) or "") if is_option else "",
        "type": parameter.type.name,
        "required": parameter.required,
        "multiple": parameter.multiple,
        "flag": is_option and parameter.is_flag,
        "choices": list(choices) if choices is not None else None,
        "default": default if isinstance(default, str | int | float | bool) else None,
    }


def describe_command(command: Any, path: list[str]) -> dict[str, Any]:
    parameters = [
        describe_parameter(parameter)
        for parameter in command.params
        if not getattr(parameter, "hidden", False) and parameter.name not in IMPLICIT
    ]
    children: list[dict[str, Any]] = []
    if isinstance(command, TyperGroup):
        children = [
            describe_command(child, [*path, name])
            for name, child in sorted(command.commands.items())
            if not child.hidden
        ]
    return {
        "path": path,
        "help": (command.help or "").strip(),
        "parameters": parameters,
        "commands": children,
    }


def main() -> None:
    document = describe_command(typer.main.get_command(app), ["pbmb"])
    sys.stdout.write(json.dumps(document, indent=2) + "\n")


if __name__ == "__main__":
    main()
