import pytest
from cli_support import URL


@pytest.fixture(autouse=True)
def signed_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PBMB_API_KEY", "pbmb_sk_test")
    monkeypatch.setenv("PBMB_URL", URL)
    # Rich wraps tables at 80 columns when it is not on a terminal.
    monkeypatch.setenv("COLUMNS", "200")
