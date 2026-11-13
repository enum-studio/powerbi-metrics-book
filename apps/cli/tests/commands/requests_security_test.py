"""What a typed or server-supplied id, a CSV link and the api's text can and
cannot make the CLI do."""

import json
import re
import stat
from pathlib import Path

import httpx
import pytest
from cli_support import Serve, api_error, json_response
from commands_support import CSV_URL, RESULT, SIGNATURE, csv_handler, run

from powerbi_metrics_book.commands import admin

REPOSITORY = Path(__file__).resolve().parents[4]
# Lower case, so only a list of the real names tells them from a name.
TYPED_VALUES = (
    "3f9a7c1e0b",
    "a_value_typed_here",
    "sign_in_client_secret",
    "sign_in__client_secret",
)


def test_a_secret_name_that_could_leave_its_route_is_refused_before_the_prompt(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    def never(prompt: str) -> str:
        raise AssertionError("prompted")

    monkeypatch.setattr(admin, "_has_terminal", lambda: True)
    monkeypatch.setattr(admin.getpass, "getpass", never)
    seen = serve(lambda request: json_response(200, {}))

    for name in ("../settings/x#", "Open_AI", "a/b", "", *TYPED_VALUES):
        result = run("admin", "secrets", "set", name)
        assert result.exit_code == 2, name
        assert "not the name of a secret" in result.stderr
        assert not name or name not in result.stdout + result.stderr
    assert seen == []


def test_extra_words_after_a_secret_name_get_our_refusal_and_are_never_echoed(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "secrets", "set", "openai_api_key", "my", "secret")

    assert result.exit_code == 2
    assert "only read from a prompt" in result.stderr
    assert "unexpected" not in result.stderr
    assert "my" not in result.stderr.split()
    assert seen == []


def test_the_expiry_command_refuses_what_is_no_secret_name_before_any_request(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    for name in (
        "../settings/x#",
        "Open_AI",
        "a/b",
        "sk-typed-here",
        "",
        *TYPED_VALUES,
    ):
        result = run("admin", "secrets", "expiry", name, "2027-01-31")
        assert result.exit_code == 2, name
        assert "not the name of a secret" in result.stderr
        assert not name or name not in result.stdout + result.stderr
    assert seen == []


def test_the_name_check_lets_through_every_secret_the_api_knows(serve: Serve) -> None:
    readers = (REPOSITORY / "apps/api/src/services/secrets/readers.ts").read_text()
    table = readers.split("FIXED_READERS", 1)[1].split("};", 1)[0]
    fixed = re.findall(r'^\s+"?(\w+)"?:', table, re.MULTILINE)
    assert "result_link_key" in fixed
    *known, sign_in = admin.SECRET_NAME.pattern.split("|")
    assert sorted(known) == sorted(fixed)
    assert f"/^{sign_in}$/" in readers
    seen = serve(lambda request: json_response(200, {}))

    names = [*fixed, "sign_in_acme_client_secret", "sign_in_a1_b_client_secret"]
    for name in names:
        result = run("admin", "secrets", "expiry", name, "2027-01-31")
        assert result.exit_code == 0, name

    assert [request.url.path.split("/")[-2] for request in seen] == names


def test_extra_words_after_an_expiry_date_get_our_refusal_and_are_never_echoed(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run(
        "admin", "secrets", "expiry", "openai_api_key", "2027-01-31", "my", "secret"
    )

    assert result.exit_code == 2
    assert "only read from a prompt" in result.stderr
    assert "unexpected" not in result.stderr
    assert "my" not in result.stderr.split()
    assert seen == []


@pytest.mark.parametrize(
    "words",
    [
        ("set", "openai_api_key", "--sk-typed-here"),
        ("set", "--sk-typed-here"),
        ("expiry", "openai_api_key", "--sk-typed-here"),
        ("expiry", "openai_api_key", "2027-01-31", "--sk-typed-here"),
        ("expiry", "openai_api_key", "sk-typed-here"),
    ],
)
def test_a_value_typed_anywhere_on_a_secret_command_is_never_echoed(
    words: tuple[str, ...], serve: Serve
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "secrets", *words)

    assert result.exit_code == 2
    assert "sk-typed-here" not in result.stdout + result.stderr
    assert seen == []


def test_a_thread_id_stays_under_threads(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"id": "x"}))

    run("questions", "show", "../../admin/roles/x#")

    assert seen[0].url.raw_path == b"/api/v1/threads/..%2F..%2Fadmin%2Froles%2Fx%23"


@pytest.mark.parametrize("segment", ["..", ".", ""])
def test_an_id_that_is_a_dot_segment_is_refused_without_a_request(
    serve: Serve, segment: str
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("queries", "show", segment)

    assert result.exit_code == 2
    assert "empty, '.' or '..'" in result.stderr
    assert seen == []


def test_a_result_id_from_the_server_stays_under_results(
    tmp_path: Path, serve: Serve
) -> None:
    seen = serve(
        lambda request: (
            json_response(201, {**RESULT, "result_id": "a/b#c"})
            if request.url.path == "/api/v1/queries"
            else csv_handler(request)
        )
    )

    run("dax", "run", "ds_1", "--query", "x", "--csv", str(tmp_path / "out.csv"))

    assert seen[1].url.raw_path == b"/api/v1/results/a%2Fb%23c/csv-link"


def test_a_result_answer_without_an_id_asks_nothing_more(serve: Serve) -> None:
    answer = {key: value for key, value in RESULT.items() if key != "result_id"}
    seen = serve(lambda request: json_response(201, answer))

    result = run("dax", "run", "ds_1", "--query", "x", "--csv", "out.csv")

    assert result.exit_code == 1
    assert "did not answer a result_id" in result.stderr
    assert len(seen) == 1


@pytest.mark.parametrize(
    "link",
    [
        f"https://elsewhere.sample-data.test/csv?signature={SIGNATURE}",
        f"http://book.sample-data.test/csv?signature={SIGNATURE}",
        f"https://book.sample-data.test:8443/csv?signature={SIGNATURE}",
    ],
)
def test_a_link_on_another_origin_is_not_downloaded(
    tmp_path: Path, serve: Serve, link: str
) -> None:
    seen = serve(lambda request: csv_handler(request, link))

    result = run("results", "csv", "res_1", "-o", str(tmp_path / "out.csv"))

    assert result.exit_code == 1
    assert "another address than its own" in result.stderr
    assert SIGNATURE not in result.stdout + result.stderr
    assert [request.method for request in seen] == ["POST"]
    assert list(tmp_path.iterdir()) == []


def test_a_redirect_from_the_link_is_not_followed(tmp_path: Path, serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/csv"):
            return httpx.Response(302, headers={"location": "https://evil.test/x"})
        return csv_handler(request)

    seen = serve(handler)

    result = run("results", "csv", "res_1", "-o", str(tmp_path / "out.csv"))

    assert result.exit_code == 1
    assert "answered 302" in result.stderr
    assert [request.url.host for request in seen] == ["book.sample-data.test"] * 2
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("answer", "sentence"),
    [
        (
            httpx.Response(200, content=b"a,b\n\xff\xfe,1\n"),
            "not a UTF-8 CSV file",
        ),
        (
            httpx.Response(
                200, headers={"content-encoding": "gzip"}, content=iter([b"not gzip"])
            ),
            "could not be decoded",
        ),
    ],
)
def test_a_download_that_is_not_readable_csv_leaves_no_file_and_one_sentence(
    tmp_path: Path, serve: Serve, answer: httpx.Response, sentence: str
) -> None:
    serve(
        lambda request: (
            answer if request.url.path.endswith("/csv") else csv_handler(request)
        )
    )

    result = run("results", "csv", "res_1", "-o", str(tmp_path / "out.csv"))

    assert result.exit_code == 1
    assert sentence in result.stderr
    assert "Traceback" not in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_a_link_that_is_not_a_url_is_one_sentence(tmp_path: Path, serve: Serve) -> None:
    serve(
        lambda request: csv_handler(request, "http://book.sample-data.test:notaport/x")
    )

    result = run("results", "csv", "res_1", "-o", str(tmp_path / "out.csv"))

    assert result.exit_code == 1
    assert "not a URL" in result.stderr
    assert "notaport" not in result.stderr


def test_the_downloaded_file_is_readable_by_its_owner_only(
    tmp_path: Path, serve: Serve
) -> None:
    serve(csv_handler)
    target = tmp_path / "out.csv"

    assert run("results", "csv", "res_1", "-o", str(target)).exit_code == 0

    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert CSV_URL not in target.read_text()


def test_control_characters_from_the_api_never_reach_the_terminal(
    serve: Serve,
) -> None:
    escape = "\x1b]0;owned\x07"
    serve(
        lambda request: json_response(
            200, {"id": "q", "purpose": f"a{escape}b\x9bc", "dax": "x\ny\tz"}
        )
    )

    shown = run("queries", "show", "q")
    as_json = run("queries", "show", "q", "--json")

    assert "\x1b" not in shown.stdout and "\x07" not in shown.stdout
    assert "\x9b" not in shown.stdout
    assert "a]0;ownedbc" in shown.stdout
    assert json.loads(as_json.stdout)["purpose"] == f"a{escape}b\x9bc"


def test_control_characters_in_the_apis_error_sentence_are_removed(
    serve: Serve,
) -> None:
    serve(lambda request: api_error(403, "refused", "No \x1b[31mred\x1b[0m for you."))

    result = run("admin", "status")

    assert result.exit_code == 4
    assert result.stderr == "No [31mred[0m for you.\n"
    assert run("whoami").stderr == result.stderr


def test_control_characters_in_a_page_and_an_export_are_removed(serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/export"):
            return json_response(200, {"yaml": "a: \x1b[2Jb\n"})
        page = {
            "columns": [],
            "rows": [],
            "row_count": "7\x1b[2J",
            "next_offset": "\x9b9",
        }
        return json_response(200, page)

    serve(handler)

    read = run("results", "read", "res_1")

    assert "7[2J rows" in read.stdout and "offset 9" in read.stdout
    assert "\x1b" not in read.stdout and "\x9b" not in read.stdout
    assert run("admin", "export").stdout == "a: [2Jb\n"


def test_a_download_that_fails_the_check_keeps_the_file_already_there(
    tmp_path: Path, serve: Serve
) -> None:
    target = tmp_path / "out.csv"
    target.write_text("old,data\n1,2\n")
    serve(
        lambda request: (
            httpx.Response(200, content=b"a,b\n\xff,1\n")
            if request.url.path.endswith("/csv")
            else csv_handler(request)
        )
    )

    result = run("results", "csv", "res_1", "-o", str(target))

    assert result.exit_code == 1
    assert target.read_text() == "old,data\n1,2\n"
    assert [found.name for found in tmp_path.iterdir()] == ["out.csv"]


def test_a_server_sent_dot_id_is_blamed_on_the_server_not_the_typist(
    tmp_path: Path, serve: Serve
) -> None:
    seen = serve(lambda request: json_response(201, {**RESULT, "result_id": ".."}))

    result = run("dax", "run", "ds_1", "--query", "x", "--csv", str(tmp_path / "o.csv"))

    assert result.exit_code == 1
    assert "api answered an id the CLI will not use" in result.stderr
    assert "typed" not in result.stderr
    assert len(seen) == 1
