import importlib
from pathlib import Path
from types import ModuleType

import pytest
from typer.core import TyperCommand, TyperGroup
from typer.main import get_command
from typer.testing import CliRunner

from powerbi_metrics_book.cli import CommandModuleError, app, build_app

GROUP = """
import typer

app = typer.Typer()


@app.command()
def list_all() -> None:
    print("listed")
"""
SINGLE = """
def command() -> None:
    print("ran")
"""


def commands_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, modules: dict[str, str]
) -> ModuleType:
    package = tmp_path / name
    package.mkdir()
    (package / "__init__.py").write_text("")
    for module, source in modules.items():
        (package / f"{module}.py").write_text(source)
    monkeypatch.syspath_prepend(str(tmp_path))
    return importlib.import_module(name)


def test_a_module_with_an_app_becomes_a_group_and_one_with_a_command_becomes_a_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = commands_package(
        tmp_path, monkeypatch, "commands_ok", {"metrics": GROUP, "verify": SINGLE}
    )
    built = build_app(package)

    group_run = CliRunner().invoke(built, ["metrics", "list-all"])
    command_run = CliRunner().invoke(built, ["verify"])

    assert (group_run.exit_code, group_run.stdout.strip()) == (0, "listed")
    assert (command_run.exit_code, command_run.stdout.strip()) == (0, "ran")


@pytest.mark.parametrize(
    ("name", "modules", "message"),
    [
        (
            "commands_neither",
            {"helper": "X = 1\n"},
            r"commands_neither\.helper.*neither",
        ),
        ("commands_both", {"muddled": GROUP + SINGLE}, r"commands_both\.muddled.*both"),
    ],
)
def test_a_module_with_neither_or_both_fails_at_start_up_naming_the_module(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    modules: dict[str, str],
    message: str,
) -> None:
    package = commands_package(
        tmp_path, monkeypatch, name, {"verify": SINGLE, **modules}
    )

    with pytest.raises(CommandModuleError, match=message):
        build_app(package)


def leaf_commands(
    command: TyperCommand | TyperGroup, prefix: str
) -> list[tuple[str, TyperCommand | TyperGroup]]:
    if isinstance(command, TyperGroup):
        return [
            leaf
            for name, child in command.commands.items()
            for leaf in leaf_commands(child, f"{prefix} {name}")
        ]
    return [(prefix, command)]


def test_the_real_app_has_whoami_and_every_command_takes_json() -> None:
    leaves = dict(leaf_commands(get_command(app), "pbmb"))

    assert "pbmb whoami" in leaves
    for name, command in leaves.items():
        options = {option for parameter in command.params for option in parameter.opts}
        assert "--json" in options, f"{name} has no --json"


def test_the_app_takes_url_and_json_before_the_command() -> None:
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "--url" in result.stdout
    assert "--json" in result.stdout
