import json
import os
import re
import stat
from pathlib import Path
from typing import NamedTuple

import typer
import yaml

from powerbi_metrics_book.client import Json
from powerbi_metrics_book.files import atomic_file, read_text_file

MAX_FILE_BYTES = 1024 * 1024
MAX_GUIDE_BYTES = 256 * 1024
# .env sits in the same folder, and the api serves the guide to everyone signed in.
GUIDE_RULE = (
    "the guide is a Markdown file (.md) in the deployment folder, with no part "
    "of its path starting with a dot and no symbolic link on the way"
)


class YamlLoader(yaml.SafeLoader):
    """PyYAML's safe loader with YAML 1.2 booleans, as the api reads YAML.

    YAML 1.1 reads on, off, yes and no as booleans, so the conventions key
    `off:` would load as False. Only true and false are booleans here.
    """


YamlLoader.yaml_implicit_resolvers = {
    first: [
        (tag, pattern) for tag, pattern in resolvers if tag != "tag:yaml.org,2002:bool"
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
YamlLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)


class _NoAliasLoader(YamlLoader):
    def compose_node(self, parent: yaml.Node | None, index: int) -> yaml.Node | None:
        if self.check_event(yaml.AliasEvent) or any(
            self.check_event(event) and getattr(self.current_event, "anchor", None)
            for event in (
                yaml.ScalarEvent,
                yaml.SequenceStartEvent,
                yaml.MappingStartEvent,
            )
        ):
            raise yaml.YAMLError("anchors and aliases (*name) are not allowed")
        return super().compose_node(parent, index)


READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def read_file(path: Path) -> str:
    """A deployment file's text, refusing links before reading."""
    return read_text_file(path)


def _read_guide(folder: Path, guide: str) -> str:
    """Opens each folder on the way without following a link, then the guide."""
    parts = guide.split("/")
    if not guide.endswith(".md") or any(
        part == "" or part.startswith(".") or "\0" in part for part in parts
    ):
        raise typer.BadParameter(f"guide {guide}: {GUIDE_RULE}.")
    directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            inner = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = inner
        descriptor = os.open(parts[-1], READ_FLAGS, dir_fd=directory)
    except OSError as error:
        raise typer.BadParameter(
            f"guide {guide}: {error.strerror}; {GUIDE_RULE}."
        ) from None
    finally:
        os.close(directory)
    return read_text_file(
        Path(f"guide {guide}"), MAX_GUIDE_BYTES, descriptor=descriptor
    )


def read_mapping(path: Path, text: str | None = None) -> dict[str, Json]:
    """`path`'s mapping, or `text`'s read as if it were the file at `path`."""
    try:
        document: Json = yaml.load(
            read_file(path) if text is None else text, Loader=_NoAliasLoader
        )
        if not isinstance(document, dict):
            raise typer.BadParameter(f"{path} must hold one YAML mapping.")
        return document
    except yaml.YAMLError as error:
        raise typer.BadParameter(f"{path}: {error}") from error


def read_conventions(path: Path, text: str | None = None) -> dict[str, Json]:
    document = read_mapping(path, text)
    if type(document.get("format")) is not int or document["format"] != 1:
        raise typer.BadParameter(f"{path} requires format: 1.")
    if "guide" in document:
        guide = document["guide"]
        if not isinstance(guide, str):
            raise typer.BadParameter(f"{path}: guide must be a path.")
        document["guide"] = _read_guide(path.parent, guide)
    return document


def check_output_paths(
    document: dict[str, Json], path: Path, inline_guide: bool = False
) -> None:
    targets = [path]
    if isinstance(document.get("guide"), str) and not inline_guide:
        targets.extend(
            [path.parent / "conventions", path.parent / "conventions/guide.md"]
        )
    for target in targets:
        if target.is_symlink() or not target.resolve().is_relative_to(
            path.parent.resolve()
        ):
            raise typer.BadParameter(f"Cannot write {target}: unsafe output path.")


def _write(target: Path, text: str) -> None:
    with os.fdopen(
        os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666),
        "w",
        encoding="utf-8",
    ) as stream:
        stream.write(text)


def replace_file(path: Path, text: str) -> None:
    """Writes a file beside `path` and renames it over, so no link is followed."""
    if path.is_symlink():
        raise typer.BadParameter(f"Cannot write {path}: it is a symbolic link.")
    try:
        try:
            mode = stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)
        except FileNotFoundError:
            mode = 0o600
        with atomic_file(path, mode) as (stream, _):
            stream.write(text.encode("utf-8"))
    except OSError as error:
        raise typer.BadParameter(f"Cannot write {path}: {error.strerror}.") from error


def write_conventions(
    document: dict[str, Json], path: Path, inline_guide: bool = False
) -> None:
    ordered: dict[str, Json] = {"format": 1}
    if "preset" in document:
        ordered["preset"] = document["preset"]
    ordered.update(
        {key: value for key, value in document.items() if key not in ordered}
    )
    try:
        check_output_paths(document, path, inline_guide)
        if "guide" in ordered and not inline_guide:
            guide = ordered["guide"]
            if isinstance(guide, str):
                target = path.parent / "conventions/guide.md"
                target.parent.mkdir(parents=True, exist_ok=True)
                _write(target, guide)
                ordered["guide"] = "conventions/guide.md"
        _write(path, yaml.safe_dump(ordered, sort_keys=False, allow_unicode=True))
    except OSError as error:
        raise typer.BadParameter(f"Cannot write {path}: {error.strerror}.") from error


class Baseline(NamedTuple):
    """A conventions file's text before and with a baseline's exceptions."""

    path: Path
    before: str
    after: str
    added: list[dict[str, Json]]


def add_exceptions(
    path: Path, document: dict[str, Json], added: list[dict[str, Json]]
) -> tuple[dict[str, Json], Baseline]:
    """The document with `added`, and the file's text before and with them.

    Writes nothing: the caller writes the text once the change is confirmed.
    """
    original = read_file(path)
    lines = original.splitlines(keepends=True)
    index = next(
        (
            index
            for index, line in enumerate(lines)
            if re.match(r"^exceptions\s*:", line)
        ),
        None,
    )
    indent = "  "
    if index is not None:
        following = next(
            (
                line
                for line in lines[index + 1 :]
                if line.strip() and not line.lstrip().startswith("#")
            ),
            "",
        )
        match = re.match(r"(\s*)- ", following)
        if match:
            indent = match[1]
    block = "".join(
        f"{indent}{'- ' if field_index == 0 else '  '}{key}: "
        f"{json.dumps(value, ensure_ascii=False)}\n"
        for item in added
        for field_index, (key, value) in enumerate(item.items())
    )
    if index is None:
        changed = (
            original
            + ("" if original.endswith("\n") else "\n")
            + "exceptions:\n"
            + block
        )
    else:
        header = lines[index]
        lines[index] = re.sub(r"\[\s*\]", "", header).rstrip("\r\n") + "\n" + block
        changed = "".join(lines)
    previous = document.get("exceptions", [])
    if not isinstance(previous, list):
        raise typer.BadParameter("exceptions must be a list.")
    expected = {**document, "exceptions": [*added, *previous]}
    try:
        if read_conventions(path, changed) != expected:
            raise typer.BadParameter("Inserted exceptions changed the document.")
    except typer.BadParameter:
        raise typer.BadParameter(
            "Add the exceptions by hand:\n" + yaml.safe_dump(added, sort_keys=False)
        ) from None
    return expected, Baseline(path, original, changed, added)
