import json
import os
import re
from pathlib import Path

import typer
import yaml

from powerbi_metrics_book.client import Json

MAX_FILE_BYTES = 1024 * 1024


class _NoAliasLoader(yaml.SafeLoader):
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


def read_mapping(path: Path) -> dict[str, Json]:
    try:
        if not path.is_file():
            raise typer.BadParameter(f"{path} is not a regular file.")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise typer.BadParameter(
                f"{path} is over 1 MiB; it is not a conventions file."
            )
        document: Json = yaml.load(
            path.read_text(encoding="utf-8"), Loader=_NoAliasLoader
        )
        if not isinstance(document, dict):
            raise typer.BadParameter(f"{path} must hold one YAML mapping.")
        return document
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise typer.BadParameter(f"{path}: {error}") from error


def read_conventions(path: Path) -> dict[str, Json]:
    document = read_mapping(path)
    try:
        if type(document.get("format")) is not int or document["format"] != 1:
            raise typer.BadParameter(f"{path} requires format: 1.")
        if "guide" in document:
            guide = document["guide"]
            if not isinstance(guide, str):
                raise typer.BadParameter(f"{path}: guide must be a path.")
            target = (path.parent / guide).resolve()
            if not target.is_relative_to(path.parent.resolve()):
                raise typer.BadParameter(
                    f"{path}: guide {guide} resolves outside {path.parent}."
                )
            document["guide"] = target.read_text(encoding="utf-8")
        return document
    except (OSError, UnicodeError) as error:
        raise typer.BadParameter(f"{path}: {error}") from error


def write_conventions(
    document: dict[str, Json], path: Path, inline_guide: bool = False
) -> None:
    ordered: dict[str, Json] = {"format": 1}
    if "preset" in document:
        ordered["preset"] = document["preset"]
    ordered.update(
        {key: value for key, value in document.items() if key not in ordered}
    )

    def refuse_unsafe(target: Path) -> None:
        if target.is_symlink() or not target.resolve().is_relative_to(
            path.parent.resolve()
        ):
            raise typer.BadParameter(f"Cannot write {target}: unsafe output path.")

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
        for target in (
            path,
            path.parent / "conventions",
            path.parent / "conventions/guide.md",
        ):
            refuse_unsafe(target)
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
