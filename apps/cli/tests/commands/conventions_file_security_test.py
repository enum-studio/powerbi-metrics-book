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
        "larger than 262144 bytes",
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


@pytest.mark.parametrize("name", ["old", "arbitrary"])
def test_replace_leaves_planted_hard_links_untouched(tmp_path: Path, name: str) -> None:
    from powerbi_metrics_book.conventions_file import replace_file

    folder = tmp_path / "deployment"
    folder.mkdir()
    target = tmp_path / "outside"
    target.write_text(ENV_LINE)
    path = folder / "conventions.yml"
    planted = folder / (
        f".conventions.yml.pbmb-{os.getpid()}" if name == "old" else "another-file"
    )
    planted.hardlink_to(target)
    replace_file(path, "format: 1\n")
    assert target.read_text() == ENV_LINE
    assert planted.read_text() == ENV_LINE
    assert planted.stat().st_ino == target.stat().st_ino
    assert path.read_text() == "format: 1\n"


def test_failed_replace_removes_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import typer

    from powerbi_metrics_book.conventions_file import replace_file

    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\n")

    def refuse(source: object, destination: object) -> None:
        raise OSError("rename failed")

    monkeypatch.setattr(os, "replace", refuse)
    with pytest.raises(typer.BadParameter, match="Cannot write"):
        replace_file(path, "format: 1 # changed\n")
    assert list(tmp_path.iterdir()) == [path]
    assert path.read_text() == "format: 1\n"


def test_replace_keeps_original_mode(tmp_path: Path) -> None:
    import stat

    from powerbi_metrics_book.conventions_file import replace_file

    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\n")
    path.chmod(0o640)
    replace_file(path, "format: 1 # changed\n")
    assert stat.S_IMODE(path.stat().st_mode) == 0o640


@pytest.mark.parametrize("name", ["guide.md", "conventions.yml", "book.yml"])
def test_hard_linked_deployment_files_are_refused_unread(
    serve: Serve, tmp_path: Path, name: str
) -> None:
    (tmp_path / ".env").write_text(ENV_LINE)
    path = tmp_path / name
    path.hardlink_to(tmp_path / ".env")
    conventions = tmp_path / "conventions.yml"
    if name == "guide.md":
        conventions.write_text("format: 1\nguide: guide.md\n")
    problems = (
        _check_book(path) if name == "book.yml" else _check_conventions(conventions)
    )
    assert len(problems) == 1
    assert "hard link" in problems[0]
    assert "not-a-real-secret" not in problems[0]
    seen = serve(lambda request: json_response(200, {}))
    args = ("admin", "import") if name == "book.yml" else ("conventions", "apply")
    result = run(*args, str(path if name == "book.yml" else conventions), "--yes")
    assert result.exit_code == 2
    assert "not-a-real-secret" not in result.output
    assert seen == []
