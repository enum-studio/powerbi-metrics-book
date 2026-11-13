"""The saved login: where it lives, how it is written and when it is refused."""

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# The api registers this public client; `pbmb login` and the refresh both name it.
CLIENT_ID = "pbmb-cli"


class CredentialsError(Exception):
    pass


@dataclass(frozen=True)
class Login:
    url: str
    client_id: str
    token_endpoint: str
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: datetime


def credentials_path() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    base = Path(config_home) if config_home else Path.home() / ".config"
    return base / "pbmb" / "credentials.json"


def load() -> Login | None:
    """The saved login, or None when there is none.

    Raises CredentialsError for a file other users can read (it holds a token
    that acts as the person) and for one that is not a saved login.
    """
    path = credentials_path()
    try:
        info = path.stat()
        mode = info.st_mode
    except (FileNotFoundError, NotADirectoryError):
        return None
    if info.st_uid != os.getuid():
        raise CredentialsError(
            f"{path} belongs to another user. Delete it, then run `pbmb login`."
        )
    if mode & 0o077:
        raise CredentialsError(
            f"{path} can be read by other users. Run `chmod 600 {path}`, "
            "or `pbmb login` to write it again."
        )
    try:
        document = json.loads(path.read_text())
        expires_at = datetime.fromisoformat(document["expires_at"])
        if expires_at.tzinfo is None:
            raise ValueError("expires_at has no time zone")
        return Login(
            url=document["url"],
            client_id=document["client_id"],
            token_endpoint=document["token_endpoint"],
            access_token=document["access_token"],
            refresh_token=document["refresh_token"],
            expires_at=expires_at,
        )
    except (ValueError, KeyError, TypeError) as error:
        raise CredentialsError(
            f"{path} is not a saved login ({error}). "
            "Run `pbmb login` to write it again."
        ) from error


def save(login: Login) -> None:
    """Writes the login atomically, so a crash never leaves half a token."""
    path = credentials_path()
    document = {
        "url": login.url,
        "client_id": login.client_id,
        "token_endpoint": login.token_endpoint,
        "access_token": login.access_token,
        "refresh_token": login.refresh_token,
        "expires_at": login.expires_at.astimezone(UTC).isoformat(),
    }
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.parent.chmod(0o700)
        # mkstemp creates the file 0600, so the token is never readable, even
        # briefly.
        descriptor, temporary = tempfile.mkstemp(
            dir=path.parent, prefix=".credentials-"
        )
        try:
            with os.fdopen(descriptor, "w") as file:
                json.dump(document, file, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except OSError as error:
        reason = error.strerror or str(error)
        raise CredentialsError(
            f"Cannot save your login to {path}: {reason}. "
            "Make that folder writable, then run `pbmb login` again."
        ) from error


def delete() -> None:
    credentials_path().unlink(missing_ok=True)
