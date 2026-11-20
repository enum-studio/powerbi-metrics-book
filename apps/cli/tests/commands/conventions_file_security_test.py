"""The guide and the conventions are read only from the deployment's own
Markdown and YAML files: `pbmb init` writes .env into the same folder, and a
guide is served to every signed-in principal and every MCP client."""

import os
from collections.abc import Callable
from pathlib import Path

import pytest
from cli_support import Serve, json_response
from commands_support import run

from powerbi_metrics_book.commands.check import _check_book, _check_conventions

# A line shaped like .env that YAML cannot read: an error quoting it would show it.
ENV_LINE = "PBMB_FAKE_VALUE=not-a-real-secret: shown: here"
GUIDE_RULE = "the guide is a Markdown file"
LINK_RULE = "is a symbolic link"


def _link_guide(folder: Path) -> None:
    (folder / "guide.md").symlink_to(folder / ".env")


def _link_folder(folder: Path) -> None:
    (folder / "conventions").mkdir()
    (folder / "conventions/guide.md").write_text(ENV_LINE)
    (folder / "notes").symlink_to(folder / "conventions")


def _write(name: str, text: str = ENV_LINE) -> Callable[[Path], None]:
    def prepare(folder: Path) -> None:
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(text)

    return prepare


CASES = [
    ("format: 1\nguide: .env\n", None, GUIDE_RULE),
    ("format: 1\nguide: ./.env\n", None, GUIDE_RULE),
    (
        "format: 1\nguide: conventions/.hidden.md\n",
        _write("conventions/.hidden.md"),
        GUIDE_RULE,
    ),
    ("format: 1\nguide: notes.txt\n", _write("notes.txt"), GUIDE_RULE),
    ("format: 1\nguide: guide.md\n", _link_guide, GUIDE_RULE),
    ("format: 1\nguide: notes/guide.md\n", _link_folder, GUIDE_RULE),
    (
        "format: 1\nguide: guide.md\n",
        lambda folder: os.mkfifo(folder / "guide.md"),
        "not a regular file",
    ),
    (
        "format: 1\nguide: guide.md\n",
        _write("guide.md", ENV_LINE + "\n" + "x" * 256 * 1024),
        "over 256 KiB",
    ),
    (None, lambda folder: (folder / "conventions.yml").symlink_to(".env"), LINK_RULE),
]


@pytest.mark.parametrize(
    ("document", "prepare", "rule"),
    CASES,
    ids=[
        "env",
        "dot-slash-env",
        "hidden-markdown",
        "not-markdown",
        "symlinked-guide",
        "symlinked-folder",
        "fifo",
        "over-256-kib",
        "symlinked-conventions",
    ],
)
def test_a_guide_or_conventions_file_that_could_be_env_is_refused_unread(
    serve: Serve,
    tmp_path: Path,
    document: str | None,
    prepare: Callable[[Path], None] | None,
    rule: str,
) -> None:
    (tmp_path / ".env").write_text(ENV_LINE + "\n")
    path = tmp_path / "conventions.yml"
    if document is not None:
        path.write_text(document)
    if prepare is not None:
        prepare(tmp_path)

    problems = _check_conventions(path)
    assert len(problems) == 1
    assert rule in problems[0]
    assert "not-a-real-secret" not in problems[0]

    seen = serve(lambda request: json_response(200, {}))
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 2
    assert seen == []
    assert "not-a-real-secret" not in result.output


def test_a_guide_in_a_subfolder_is_read(tmp_path: Path) -> None:
    (tmp_path / "conventions").mkdir()
    (tmp_path / "conventions/guide.md").write_text("Our guide.")
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\nguide: conventions/guide.md\n")
    assert _check_conventions(path) == []


def test_a_symlinked_book_yml_is_refused_unread(serve: Serve, tmp_path: Path) -> None:
    (tmp_path / ".env").write_text(ENV_LINE + "\n")
    book = tmp_path / "book.yml"
    book.symlink_to(".env")

    problems = _check_book(book)
    assert len(problems) == 1
    assert LINK_RULE in problems[0]
    assert "not-a-real-secret" not in problems[0]

    seen = serve(lambda request: json_response(200, {}))
    result = run("admin", "import", str(book), "--yes")
    assert result.exit_code == 2
    assert seen == []
    assert "not-a-real-secret" not in result.output
