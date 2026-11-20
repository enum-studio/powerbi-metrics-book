import json
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cli_support import a_login

from powerbi_metrics_book import credentials
from powerbi_metrics_book.credentials import CredentialsError


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_the_login_is_saved_0600_inside_a_0700_directory(tmp_path: Path) -> None:
    credentials.save(a_login())

    path = tmp_path / "config" / "pbmb" / "credentials.json"
    assert credentials.credentials_path() == path
    assert mode_of(path) == 0o600
    assert mode_of(path.parent) == 0o700


def test_saving_tightens_a_directory_and_a_file_that_were_loose(
    tmp_path: Path,
) -> None:
    path = tmp_path / "config" / "pbmb" / "credentials.json"
    path.parent.mkdir(parents=True)
    path.write_text("{}")
    path.chmod(0o644)
    path.parent.chmod(0o755)

    credentials.save(a_login())

    assert (mode_of(path), mode_of(path.parent)) == (0o600, 0o700)
    assert [file.name for file in path.parent.iterdir()] == ["credentials.json"]


def test_a_saved_login_loads_with_its_expiry_in_utc() -> None:
    expires_at = datetime(2026, 11, 2, 9, 30, tzinfo=timezone(timedelta(hours=2)))
    login = a_login(expires_at=expires_at)

    credentials.save(login)

    assert credentials.load() == login
    document = json.loads(credentials.credentials_path().read_text())
    assert document["expires_at"] == "2026-11-02T07:30:00+00:00"
    assert set(document) == {
        "url",
        "client_id",
        "token_endpoint",
        "access_token",
        "refresh_token",
        "expires_at",
    }


def test_the_directory_is_xdg_config_home_else_dot_config_in_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME")
    monkeypatch.setenv("HOME", str(tmp_path))

    assert credentials.credentials_path() == (
        tmp_path / ".config" / "pbmb" / "credentials.json"
    )


def test_there_is_no_login_until_one_is_saved() -> None:
    assert credentials.load() is None


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o644, 0o666])
def test_a_file_other_users_can_read_is_refused(mode: int) -> None:
    credentials.save(a_login())
    credentials.credentials_path().chmod(mode)

    with pytest.raises(CredentialsError, match="can be read by other users"):
        credentials.load()


def test_saving_again_makes_a_refused_file_readable_to_the_cli_again() -> None:
    credentials.save(a_login())
    credentials.credentials_path().chmod(0o644)

    credentials.save(a_login(access_token="rewritten"))

    login = credentials.load()
    assert login is not None
    assert login.access_token == "rewritten"


@pytest.mark.parametrize(
    "content",
    ["not json", "[]", '{"url": "https://book.sample-data.test"}'],
)
def test_a_file_that_is_not_a_saved_login_is_refused_with_the_way_out(
    content: str,
) -> None:
    path = credentials.credentials_path()
    path.parent.mkdir(parents=True)
    path.write_text(content)
    path.chmod(0o600)

    with pytest.raises(CredentialsError, match="is not a saved login") as raised:
        credentials.load()

    assert "pbmb login" in str(raised.value)


def test_an_expiry_without_a_time_zone_is_refused() -> None:
    credentials.save(a_login())
    path = credentials.credentials_path()
    document = json.loads(path.read_text())
    document["expires_at"] = "2026-11-02T07:30:00"
    path.write_text(json.dumps(document))

    with pytest.raises(CredentialsError, match="no time zone"):
        credentials.load()


def test_deleting_removes_the_login_and_is_fine_when_there_is_none() -> None:
    credentials.save(a_login())

    credentials.delete()
    credentials.delete()

    assert credentials.load() is None


def test_a_failed_write_leaves_the_saved_login_and_no_temporary_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credentials.save(a_login(access_token="first"))

    def fail(*args: object, **kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(json, "dumps", fail)
    with pytest.raises(CredentialsError, match="disk full"):
        credentials.save(a_login(access_token="second"))

    saved = credentials.load()
    assert saved is not None and saved.access_token == "first"
    directory = credentials.credentials_path().parent
    assert [entry.name for entry in directory.iterdir()] == [
        credentials.credentials_path().name
    ]
