"""Reading a file a command sends to the api."""

import errno
import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

import typer

MAX_FILE_BYTES = 1024 * 1024


def read_text_file(
    path: Path, limit: int = MAX_FILE_BYTES, *, descriptor: int | None = None
) -> str:
    """The UTF-8 text of a regular file of at most `limit` bytes.

    A path is only a name: it can be a device that never ends, a pipe that
    never answers, or the file holding the login. The file is opened first and
    judged by what the open file is, so nothing changes between the check and
    the read. Each refusal is a one-sentence usage error (exit 2).
    """
    if descriptor is None:
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError as error:
            if error.errno == errno.ELOOP:
                raise typer.BadParameter(
                    f"{path} is a symbolic link; the CLI reads only a regular file."
                ) from None
            raise typer.BadParameter(
                f"Cannot open {path}: {error.strerror or type(error).__name__}."
            ) from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise typer.BadParameter(f"{path} is not a regular file.")
        if _is_login_file(info):
            raise typer.BadParameter(
                f"Not sending your saved login: {path} is the file that holds it."
            )
        if info.st_nlink > 1:
            raise typer.BadParameter(
                f"{path} is a hard link; the CLI reads only a file with one link."
            )
        data = b""
        while len(data) <= limit:
            chunk = os.read(descriptor, limit + 1 - len(data))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(descriptor)
    if len(data) > limit:
        raise typer.BadParameter(f"{path} is larger than {limit} bytes.")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise typer.BadParameter(f"{path} is not UTF-8 text.") from error


def _is_login_file(info: os.stat_result) -> bool:
    from powerbi_metrics_book import credentials

    try:
        return os.path.samestat(info, credentials.credentials_path().stat())
    except OSError:
        return False


@contextmanager
def atomic_file(path: Path, mode: int = 0o600) -> Iterator[tuple[BinaryIO, Path]]:
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            yield stream, temporary
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
