"""Reading a file a command sends to the api."""

import errno
import os
import stat
from pathlib import Path

import typer

from powerbi_metrics_book import credentials

MAX_FILE_BYTES = 1024 * 1024


def read_text_file(
    path: Path,
    limit: int = MAX_FILE_BYTES,
    *,
    links: bool = True,
    descriptor: int | None = None,
) -> str:
    """The UTF-8 text of a regular file of at most `limit` bytes.

    A path is only a name: it can be a device that never ends, a pipe that
    never answers, or the file holding the login. The file is opened first and
    judged by what the open file is, so nothing changes between the check and
    the read. Each refusal is a one-sentence usage error (exit 2).

    With `links=False`, for a deployment's own files, a symbolic or hard link
    is refused: either could name the deployment's .env. `descriptor` is the
    file already opened, when the caller had to open it itself.
    """
    if descriptor is None:
        flags = os.O_RDONLY | os.O_NONBLOCK | (0 if links else os.O_NOFOLLOW)
        try:
            descriptor = os.open(path, flags)
        except OSError as error:
            if error.errno == errno.ELOOP and not links:
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
        if not links and info.st_nlink > 1:
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
    try:
        return os.path.samestat(info, credentials.credentials_path().stat())
    except OSError:
        return False
