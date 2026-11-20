import errno
import json
import os
import re
import stat
from pathlib import Path

import typer
import yaml

from powerbi_metrics_book.client import Json

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


def _read_open(descriptor: int, name: str, limit: int, size: str) -> str:
    """An opened file's text: a regular file of at most `limit` bytes."""
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise typer.BadParameter(f"{name} is not a regular file.")
    with os.fdopen(descriptor, "rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise typer.BadParameter(f"{name} is over {size}.")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise typer.BadParameter(f"{name} is not UTF-8 text.") from None


# Non-blocking, so a FIFO is refused rather than waited on.
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def read_file(path: Path) -> str:
    """A deployment file's text. A symbolic link is refused: it could name .env."""
    try:
        descriptor = os.open(path, READ_FLAGS)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise typer.BadParameter(
                f"{path} is a symbolic link; the CLI reads only a regular file."
            ) from None
        raise typer.BadParameter(f"{path}: {error.strerror}.") from None
    return _read_open(descriptor, str(path), MAX_FILE_BYTES, "1 MiB")


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
    return _read_open(descriptor, f"guide {guide}", MAX_GUIDE_BYTES, "256 KiB")


def read_mapping(path: Path) -> dict[str, Json]:
    try:
        document: Json = yaml.load(read_file(path), Loader=_NoAliasLoader)
        if not isinstance(document, dict):
            raise typer.BadParameter(f"{path} must hold one YAML mapping.")
        return document
    except yaml.YAMLError as error:
        raise typer.BadParameter(f"{path}: {error}") from error


def read_conventions(path: Path) -> dict[str, Json]:
    document = read_mapping(path)
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


def write_conventions(
    document: dict[str, Json], path: Path, inline_guide: bool = False
) -> None:
    ordered: dict[str, Json] = {"format": 1}
    if "preset" in document:
        ordered["preset"] = document["preset"]
    ordered.update(
        {key: value for key, value in document.items() if key not in ordered}
    )

    def write(target: Path, text: str) -> None:
        with os.fdopen(
            os.open(
                target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666
            ),
            "w",
            encoding="utf-8",
        ) as stream:
            stream.write(text)

    try:
        check_output_paths(document, path, inline_guide)
        if "guide" in ordered and not inline_guide:
            guide = ordered["guide"]
            if isinstance(guide, str):
                target = path.parent / "conventions/guide.md"
                target.parent.mkdir(parents=True, exist_ok=True)
                write(target, guide)
                ordered["guide"] = "conventions/guide.md"
        write(path, yaml.safe_dump(ordered, sort_keys=False, allow_unicode=True))
    except OSError as error:
        raise typer.BadParameter(f"Cannot write {path}: {error.strerror}.") from error


def add_exceptions(
    path: Path, document: dict[str, Json], added: list[dict[str, Json]]
) -> dict[str, Json]:
    original = path.read_text(encoding="utf-8")
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
        path.write_text(changed, encoding="utf-8")
        loaded = read_conventions(path)
        if loaded != expected:
            raise typer.BadParameter("Inserted exceptions changed the document.")
    except (typer.BadParameter, OSError):
        path.write_text(original, encoding="utf-8")
        raise typer.BadParameter(
            "Add the exceptions by hand:\n" + yaml.safe_dump(added, sort_keys=False)
        ) from None
    return loaded
