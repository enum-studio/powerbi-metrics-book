"""Replacing a file whole, so a reader sees the old file or the new one."""

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO


@contextmanager
def atomic_file(path: Path, mode: int = 0o600) -> Iterator[tuple[BinaryIO, Path]]:
    """Yields a new file beside `path` and its name, then renames it over `path`.

    mkstemp creates the file exclusively, so nothing planted beside `path` is
    written through. The new file is removed if the body fails.
    """
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            yield stream, temporary
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
