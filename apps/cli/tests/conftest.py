from pathlib import Path

import httpx
import pytest
from cli_support import Handler, Serve


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No test reads this machine's login, key or deployment."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.delenv("PBMB_API_KEY", raising=False)
    monkeypatch.delenv("PBMB_URL", raising=False)


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Serve:
    """Answers every request the CLI makes with `handler`, and records them."""

    def install(handler: Handler) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def answer(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        transport = httpx.MockTransport(answer)

        class MockedClient(httpx.Client):
            def __init__(self, *, base_url: str, timeout: float) -> None:
                super().__init__(
                    base_url=base_url, timeout=timeout, transport=transport
                )

        monkeypatch.setattr(httpx, "Client", MockedClient)
        return seen

    return install
