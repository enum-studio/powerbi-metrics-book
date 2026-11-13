import json
from pathlib import Path

import httpx
import pytest
from cli_support import Serve, api_error, json_response
from commands_support import RESULT, SIGNATURE, csv_handler, run, sent
from typer.testing import Result

from powerbi_metrics_book.commands import admin, events


def test_a_secret_value_on_the_command_line_is_refused_and_never_echoed(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "secrets", "set", "openai_api_key", "sk-xyz")

    assert result.exit_code == 2
    assert "only read from a prompt" in result.stderr
    assert "sk-xyz" not in result.stdout + result.stderr
    assert seen == []


def test_a_secret_is_refused_without_a_terminal(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "secrets", "set", "openai_api_key", input="sk-piped\n")

    assert result.exit_code == 2
    assert "only read from a prompt" in result.stderr
    assert "sk-piped" not in result.stdout + result.stderr
    assert seen == []


def test_a_secret_typed_at_the_prompt_is_sent_and_never_printed(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    monkeypatch.setattr(admin, "_has_terminal", lambda: True)
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: "sk-typed")
    answer = {"name": "openai_api_key", "set": True, "hint": "yped"}
    seen = serve(lambda request: json_response(200, answer))

    result = run("admin", "secrets", "set", "openai_api_key", "--expires", "2027-01-31")

    assert result.exit_code == 0
    assert (seen[0].method, seen[0].url.path) == (
        "PUT",
        "/api/v1/admin/secrets/openai_api_key",
    )
    assert sent(seen[0]) == {"value": "sk-typed", "expires_at": "2027-01-31T23:59:59Z"}
    assert "sk-typed" not in result.stdout + result.stderr


def test_an_expiry_date_is_saved_as_that_day_without_asking_for_the_value(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    def no_prompt(prompt: str) -> str:
        raise AssertionError("A date needs no value.")

    monkeypatch.setattr(admin.getpass, "getpass", no_prompt)
    answer = {"name": "powerbi_app_client_secret", "set": True, "hint": "cret"}
    seen = serve(lambda request: json_response(200, answer))

    result = run(
        "admin",
        "secrets",
        "expiry",
        "powerbi_app_client_secret",
        "2027-01-31",
        "--json",
    )

    assert result.exit_code == 0
    assert (seen[0].method, seen[0].url.path) == (
        "PUT",
        "/api/v1/admin/secrets/powerbi_app_client_secret/expiry",
    )
    assert sent(seen[0]) == {"expires_at": "2027-01-31T23:59:59Z"}
    assert json.loads(result.stdout) == answer


@pytest.mark.parametrize("day", ["31-01-2027", "2027-02-30", "2027-01-31T23:59:59Z"])
def test_an_expiry_date_that_is_no_day_is_refused_before_any_request(
    day: str, serve: Serve
) -> None:
    seen = serve(lambda request: json_response(200, {}))

    result = run("admin", "secrets", "expiry", "powerbi_app_client_secret", day)

    assert result.exit_code == 2
    assert "Write the day as YYYY-MM-DD." in result.stderr
    assert seen == []


def test_dax_run_prints_the_preview_and_the_result_id(serve: Serve) -> None:
    seen = serve(lambda request: json_response(201, RESULT))

    result = run(
        "dax",
        "run",
        "ds_1",
        "--query",
        "EVALUATE Sales",
        "--purpose",
        "check",
        "--preview",
        "2",
    )

    assert result.exit_code == 0
    assert sent(seen[0]) == {
        "dataset": "ds_1",
        "dax": "EVALUATE Sales",
        "purpose": "check",
        "preview_rows": 2,
    }
    for expected in ("Denmark", "Norway", "res_1", "2 rows"):
        assert expected in result.stdout
    assert SIGNATURE not in result.stdout


def test_dax_run_reads_the_dax_from_a_file_and_json_is_one_document(
    tmp_path: Path, serve: Serve
) -> None:
    query = tmp_path / "query.dax"
    query.write_text("EVALUATE Sales")
    seen = serve(lambda request: json_response(201, RESULT))

    result = run("dax", "run", "ds_1", "--file", str(query), "--json")

    assert result.exit_code == 0
    assert json.loads(result.stdout)["result_id"] == "res_1"
    assert sent(seen[0]) == {
        "dataset": "ds_1",
        "dax": "EVALUATE Sales",
        "purpose": None,
    }


def test_dax_run_wants_exactly_one_source_for_the_dax() -> None:
    assert run("dax", "run", "ds_1").exit_code == 2
    assert run("dax", "run", "ds_1", "--query", "a", "--file", __file__).exit_code == 2


def test_dax_run_csv_downloads_from_the_signed_link_without_a_credential(
    tmp_path: Path, serve: Serve
) -> None:
    seen = serve(csv_handler)
    target = tmp_path / "out.csv"

    result = run(
        "dax", "run", "ds_1", "--query", "EVALUATE Sales", "--csv", str(target)
    )

    assert result.exit_code == 0
    assert target.read_text() == 'Country,Net\nDenmark,10\n"Nor\nway",7\n'
    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/api/v1/queries"),
        ("POST", "/api/v1/results/res_1/csv-link"),
        ("GET", "/api/v1/results/res_1/csv"),
    ]
    assert "authorization" not in seen[2].headers
    assert result.stdout.strip() == f"{target}: 2 rows"
    assert not list(tmp_path.glob("*.part"))


def test_a_refused_download_leaves_no_file_and_never_shows_the_signature(
    tmp_path: Path, serve: Serve
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/csv"):
            return api_error(403, "refused", "That link has expired.")
        return csv_handler(request)

    serve(handler)
    target = tmp_path / "out.csv"

    result = run("results", "csv", "res_1", "-o", str(target))

    assert result.exit_code == 4
    assert "expired" in result.stderr
    assert SIGNATURE not in result.stdout + result.stderr
    assert list(tmp_path.iterdir()) == []


def test_a_download_that_cannot_connect_names_the_host_and_not_the_link(
    tmp_path: Path, serve: Serve
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/csv"):
            raise httpx.ConnectError("refused", request=request)
        return csv_handler(request)

    serve(handler)

    result = run("results", "csv", "res_1", "-o", str(tmp_path / "out.csv"))

    assert result.exit_code == 1
    assert "book.sample-data.test" in result.stderr
    assert SIGNATURE not in result.stdout + result.stderr


def test_results_read_pages_and_names_the_next_offset(serve: Serve) -> None:
    page = {
        "result_id": "res_1",
        "query_id": "qry_1",
        "columns": RESULT["columns"],
        "row_count": 500,
        "offset": 100,
        "rows": [["Denmark", 10]],
        "next_offset": 101,
        "note": None,
    }
    seen = serve(lambda request: json_response(200, page))

    result = run("results", "read", "res_1", "--offset", "100", "--limit", "1")

    assert result.exit_code == 0
    assert dict(seen[0].url.params) == {"offset": "100", "limit": "1"}
    assert "Denmark" in result.stdout
    assert "pbmb results read res_1 --offset 101" in result.stdout


def test_queries_search_sends_its_filters_and_shows_each_query(serve: Serve) -> None:
    item = {
        "id": "qry_1",
        "at": "2026-10-25T10:00:00Z",
        "status": "succeeded",
        "dataset": {"kind": "dataset", "id": "ds_1", "name": "Sales"},
        "row_count": 2,
        "purpose": "check",
    }
    seen = serve(
        lambda request: json_response(200, {"items": [item], "next_cursor": None})
    )

    result = run(
        "queries",
        "search",
        "net sales",
        "--dataset",
        "ds_1",
        "--mine",
        "--status",
        "failed",
        "--since",
        "2026-10-01T00:00:00Z",
    )

    assert result.exit_code == 0
    assert dict(seen[0].url.params) == {
        "text": "net sales",
        "dataset": "ds_1",
        "mine": "true",
        "status": "failed",
        "since": "2026-10-01T00:00:00Z",
    }
    assert "qry_1" in result.stdout and "Sales" in result.stdout


def test_queries_show_prints_the_logged_query(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(200, {"id": "qry_1", "dax": "EVALUATE Sales"})
    )

    result = run("queries", "show", "qry_1")

    assert result.exit_code == 0
    assert seen[0].url.path == "/api/v1/queries/qry_1"
    assert "EVALUATE Sales" in result.stdout


def test_ask_posts_a_question_about_an_element(serve: Serve) -> None:
    seen = serve(lambda request: json_response(201, {"id": "thr_1", "status": "open"}))

    result = run(
        "questions",
        "ask",
        "metric",
        "total_net_sales",
        "--title",
        "Why?",
        "--body",
        "Is VAT in?",
    )

    assert result.exit_code == 0
    assert (seen[0].method, seen[0].url.path) == ("POST", "/api/v1/threads")
    assert sent(seen[0]) == {
        "kind": "question",
        "element": {"kind": "metric", "id": "total_net_sales"},
        "title": "Why?",
        "body": "Is VAT in?",
    }


def test_comment_has_no_title(serve: Serve) -> None:
    seen = serve(lambda request: json_response(201, {"id": "thr_2"}))

    run("questions", "comment", "column", "c1", "--body", "Looks wrong")

    assert sent(seen[0]) == {
        "kind": "comment",
        "element": {"kind": "column", "id": "c1"},
        "body": "Looks wrong",
    }


def test_questions_list_splits_the_element_and_refuses_a_bad_one(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"items": [], "next_cursor": None}))

    assert (
        run(
            "questions", "list", "--mine", "--status", "open", "--element", "metric:a:b"
        ).exit_code
        == 0
    )
    assert dict(seen[0].url.params) == {
        "mine": "true",
        "status": "open",
        "element_kind": "metric",
        "element_id": "a:b",
    }
    assert run("questions", "list", "--element", "metric").exit_code == 2


def test_show_lists_the_replies(serve: Serve) -> None:
    thread = {
        "id": "thr_1",
        "title": "Why?",
        "replies": [
            {
                "id": "rep_1",
                "author": {"kind": "person", "id": "a@sample-data.test"},
                "body": "Yes, VAT is out.",
                "created_at": "2026-10-25T10:00:00Z",
                "accepted": True,
            }
        ],
    }
    serve(lambda request: json_response(200, thread))

    result = run("questions", "show", "thr_1")

    assert "rep_1" in result.stdout and "VAT is out" in result.stdout


def test_reply_accept_archive_and_upvote_call_their_routes(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"id": "thr_1", "upvoted": True}))

    run("questions", "reply", "thr_1", "--body", "Yes")
    run("questions", "accept", "thr_1", "rep_1")
    run("questions", "archive", "thr_1")
    run("questions", "upvote", "thr_1")
    run("questions", "upvote", "thr_1", "--remove")

    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/api/v1/threads/thr_1/replies"),
        ("POST", "/api/v1/threads/thr_1/accept"),
        ("POST", "/api/v1/threads/thr_1/archive"),
        ("PUT", "/api/v1/threads/thr_1/upvote"),
        ("DELETE", "/api/v1/threads/thr_1/upvote"),
    ]
    assert sent(seen[0]) == {"body": "Yes"}
    assert sent(seen[1]) == {"reply_id": "rep_1"}


def test_events_asks_after_an_id_for_some_kinds(serve: Serve) -> None:
    event = {
        "id": "7",
        "at": "2026-10-25T10:00:00Z",
        "kind": "metric.verified",
        "element": {"kind": "metric", "id": "total_net_sales"},
        "data": {},
    }
    seen = serve(lambda request: json_response(200, [event]))

    result = run("events", "--after", "6", "--kinds", "metric.verified,metric.created")

    assert result.exit_code == 0
    assert dict(seen[0].url.params) == {
        "after": "6",
        "kinds": "metric.verified,metric.created",
    }
    assert "metric.verified" in result.stdout and "total_net_sales" in result.stdout


def follow_events(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, pages: list[list[dict[str, str]]]
) -> tuple[Result, list[httpx.Request], list[float]]:
    """Runs --follow over the pages; the third wait ends it with Ctrl-C."""
    waits: list[float] = []

    def sleep(seconds: float) -> None:
        waits.append(seconds)
        if len(waits) == 3:
            raise KeyboardInterrupt

    monkeypatch.setattr(events.time, "sleep", sleep)
    monkeypatch.setattr(events, "PAGE_SIZE", 2)
    seen = serve(
        lambda request: json_response(200, pages[min(len(seen), len(pages)) - 1])
    )
    return run("events", "--follow", "--json"), seen, waits


def test_events_follow_prints_json_lines_and_waits_unless_the_page_was_full(
    monkeypatch: pytest.MonkeyPatch, serve: Serve
) -> None:
    pages = [
        [{"id": "1"}, {"id": "2"}],
        [{"id": "3"}],
        [],
        [],
    ]

    result, seen, waits = follow_events(monkeypatch, serve, pages)

    assert result.exit_code == 0
    assert [json.loads(line)["id"] for line in result.stdout.splitlines()] == [
        "1",
        "2",
        "3",
    ]
    assert [r.url.params.get("after") for r in seen] == [None, "2", "3"]
    assert {r.url.params.get("limit") for r in seen} == {"2"}
    assert waits == [0.5, 5, 5]


@pytest.mark.parametrize(
    "pages",
    [[[{"id": "1"}], [{"id": "1"}]], [[{"kind": "a"}]]],
    ids=["stuck", "nameless"],
)
def test_events_follow_stops_when_the_last_id_does_not_advance_or_is_missing(
    monkeypatch: pytest.MonkeyPatch, serve: Serve, pages: list[list[dict[str, str]]]
) -> None:
    result, _, _ = follow_events(monkeypatch, serve, pages)

    assert result.exit_code == 1
    assert "no new id to continue from" in result.stderr


def test_settings_set_sends_json_when_the_value_is_json_and_text_otherwise(
    serve: Serve,
) -> None:
    seen = serve(lambda request: json_response(200, {"key": "k", "value": 1}))

    run("admin", "settings", "set", "results.ttl_hours", "48", "--save-failing")
    run("admin", "settings", "set", "powerbi.tenant_id", "contoso.test")

    assert sent(seen[0]) == {"value": 48, "save_failing": True}
    assert sent(seen[1]) == {"value": "contoso.test", "save_failing": False}


def test_settings_get_shows_one_setting_or_the_saved_ones_from_the_export(
    serve: Serve,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/admin/export":
            return json_response(
                200, {"yaml": "format: 1\nsettings:\n  results.ttl_hours: 48\n"}
            )
        return json_response(
            200, {"key": "results.ttl_hours", "value": 48, "source": "database"}
        )

    serve(handler)

    assert "database" in run("admin", "settings", "get", "results.ttl_hours").stdout
    listed = run("admin", "settings", "get", "--json")
    assert json.loads(listed.stdout) == {"settings": {"results.ttl_hours": 48}}


def test_secrets_list_shows_names_and_states_only(serve: Serve) -> None:
    secret = {
        "name": "openai_api_key",
        "readers": ["api", "worker"],
        "set": True,
        "hint": "yped",
        "set_by": "a@sample-data.test",
        "set_at": None,
        "expires_at": None,
        "check_status": "passing",
    }
    serve(lambda request: json_response(200, {"secrets": [secret]}))

    result = run("admin", "secrets", "list")

    assert "openai_api_key" in result.stdout and "passing" in result.stdout


def test_a_failing_check_prints_why_and_exits_1(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(
            200, {"status": "failing", "message": "Add the scanner to the group."}
        )
    )

    result = run("admin", "check", "scanner")

    assert result.exit_code == 1
    assert seen[0].url.path == "/api/v1/admin/checks/scanner"
    assert "Add the scanner to the group." in result.stdout


SECURITY_ANSWER = {
    "status": "failing",
    "message": "2 of the security checklist's items fail. Each says what to change.",
    "details": {
        "items": [
            {
                "item": "https",
                "status": "passing",
                "sentence": "PUBLIC_BASE_URL is https.",
            },
            {
                "item": "app_registration_read_only",
                "status": "failing",
                "sentence": "The app registration's check has not passed.",
            },
            {
                "item": "expiry_powerbi_app_client_secret",
                "status": "failing",
                "sentence": "The app registration's client secret has no expiry date.",
            },
            {
                "item": "worker_identity_volume_private",
                "status": "explained",
                "sentence": "In the worker, ls -ld shows drwx------.",
            },
        ]
    },
}


def test_a_failing_check_prints_each_failing_item_under_the_message(
    serve: Serve,
) -> None:
    serve(lambda request: json_response(200, SECURITY_ANSWER))

    result = run("admin", "check", "security")

    assert result.exit_code == 1
    assert "items fail" in result.stdout
    assert "The app registration's check has not passed." in result.stdout
    assert "The app registration's client secret has no expiry date." in result.stdout
    assert "PUBLIC_BASE_URL is https." not in result.stdout
    assert "drwx------" not in result.stdout


def test_check_json_keeps_the_details(serve: Serve) -> None:
    serve(lambda request: json_response(200, SECURITY_ANSWER))

    result = run("admin", "check", "security", "--json")

    assert result.exit_code == 1
    assert json.loads(result.stdout) == SECURITY_ANSWER


def test_roles_assign_builds_the_body_for_each_kind_of_subject(serve: Serve) -> None:
    seen = serve(lambda request: json_response(201, {"id": "r1"}))

    run("admin", "roles", "assign", "curator", "--person", "a@sample-data.test")
    run("admin", "roles", "assign", "curator", "--domain", "sample-data.test")
    run("admin", "roles", "assign", "curator", "--group", "g-1")
    run(
        "admin",
        "roles",
        "assign",
        "analyst",
        "--group",
        "g-1",
        "--provider",
        "okta",
        "--custom",
    )

    assert [sent(r) for r in seen] == [
        {"role": "curator", "subject_kind": "person", "subject": "a@sample-data.test"},
        {
            "role": "curator",
            "subject_kind": "email_domain",
            "subject": "sample-data.test",
        },
        {
            "role": "curator",
            "subject_kind": "group",
            "subject": "g-1",
            "provider": "microsoft",
        },
        {
            "role": "analyst",
            "subject_kind": "group",
            "subject": "g-1",
            "provider": "okta",
            "custom": True,
        },
    ]
    assert run("admin", "roles", "assign", "curator").exit_code == 2
    assert (
        run(
            "admin", "roles", "assign", "curator", "--person", "a", "--domain", "b"
        ).exit_code
        == 2
    )


def test_roles_list_revoke_people_and_audit(serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "DELETE":
            return httpx.Response(204)
        if path.endswith("/roles"):
            return json_response(
                200,
                {
                    "roles": [
                        {
                            "id": "r1",
                            "role": "admin",
                            "subject_kind": "person",
                            "subject": "a@sample-data.test",
                        }
                    ]
                },
            )
        if path.endswith("/people"):
            return json_response(
                200,
                {
                    "people": [
                        {
                            "id": "p1",
                            "email": "a@sample-data.test",
                            "status": "active",
                            "powerbi_connection": "connected",
                            "roles": [
                                {
                                    "role": "admin",
                                    "assignments": [],
                                    "by_default": False,
                                }
                            ],
                        }
                    ]
                },
            )
        return json_response(
            200,
            {
                "events": [
                    {
                        "id": 3,
                        "at": "2026-10-25T10:00:00Z",
                        "principal_id": "a",
                        "action": "export_book",
                        "decision": "allow",
                    }
                ]
            },
        )

    seen = serve(handler)

    assert "r1" in run("admin", "roles", "list").stdout
    assert json.loads(run("admin", "roles", "revoke", "r1", "--json").stdout) == {
        "id": "r1",
        "revoked": True,
    }
    [row] = [
        line
        for line in run("admin", "people").stdout.splitlines()
        if "a@sample-data.test" in line
    ]
    assert row.split() == [
        "a@sample-data.test",
        "active",
        "admin",
        "connected",
        "-",
        "-",
    ]
    assert (
        "export_book" in run("admin", "audit", "--since", "2026-10-01T00:00:00Z").stdout
    )
    assert seen[-1].url.params["since"] == "2026-10-01T00:00:00Z"


def test_export_writes_book_yml_or_prints_it(tmp_path: Path, serve: Serve) -> None:
    serve(lambda request: json_response(200, {"yaml": "format: 1\n"}))
    target = tmp_path / "book.yml"

    assert run("admin", "export", "-o", str(target)).exit_code == 0
    assert target.read_text() == "format: 1\n"
    assert run("admin", "export").stdout == "format: 1\n"
    assert json.loads(run("admin", "export", "--json").stdout) == {
        "yaml": "format: 1\n"
    }


def test_settings_get_help_says_it_lists_saved_values_only() -> None:
    help_text = " ".join(run("admin", "settings", "get", "--help").stdout.split())

    assert "only the values this deployment has saved" in help_text


def test_import_shows_the_difference_and_applies_only_after_yes(
    tmp_path: Path, serve: Serve
) -> None:
    book = tmp_path / "book.yml"
    book.write_text("format: 1\n")
    changes = [{"path": "settings.results.ttl_hours", "before": 24, "after": 48}]

    def handler(request: httpx.Request) -> httpx.Response:
        applied = bool(sent(request)["apply"])
        return json_response(200, {"changes": changes, "kept": {}, "applied": applied})

    seen = serve(handler)

    declined = run("admin", "import", str(book), input="n\n")
    assert declined.exit_code == 1
    assert "settings.results.ttl_hours" in declined.stdout
    assert [sent(r)["apply"] for r in seen] == [False]

    approved = run("admin", "import", str(book), input="y\n")
    assert approved.exit_code == 0
    assert [sent(r)["apply"] for r in seen[1:]] == [False, True]

    unattended = run("admin", "import", str(book), "--yes", "--json")
    assert json.loads(unattended.stdout)["applied"] is True

    preview = run("admin", "import", str(book), "--json")
    assert json.loads(preview.stdout)["applied"] is False


def test_sync_run_asks_for_a_full_scan_and_status_lists_runs(serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return json_response(202, {"job_id": "j1", "queued": True})
        return json_response(
            200,
            {
                "runs": [
                    {
                        "id": "s1",
                        "kind": "full",
                        "status": "succeeded",
                        "workspaces_scanned": 4,
                    }
                ]
            },
        )

    seen = serve(handler)

    assert run("sync", "run", "--full").exit_code == 0
    assert run("sync", "run").exit_code == 0
    assert "succeeded" in run("sync", "status").stdout
    assert [sent(r) for r in seen[:2]] == [{"kind": "full"}, {"kind": "incremental"}]


ACCOUNT = {
    "name": "reporting",
    "owner_email": "a@sample-data.test",
    "roles": ["viewer"],
    "max_key_age_days": 30,
}


def test_sa_create_sends_its_lists_and_disable_delete_list_call_their_routes(
    serve: Serve,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(204)
        return json_response(
            200, {"service_accounts": [ACCOUNT]} if request.method == "GET" else ACCOUNT
        )

    seen = serve(handler)

    run(
        "sa",
        "create",
        "reporting",
        "--owner",
        "a@sample-data.test",
        "--role",
        "viewer",
        "--role",
        "curator",
        "--workspace",
        "w1",
        "--app",
        "a1",
        "--max-key-age-days",
        "30",
    )
    assert "reporting" in run("sa", "list").stdout
    run("sa", "disable", "reporting")
    run("sa", "delete", "reporting")

    assert sent(seen[0]) == {
        "name": "reporting",
        "owner_email": "a@sample-data.test",
        "roles": ["viewer", "curator"],
        "workspace_ids": ["w1"],
        "app_ids": ["a1"],
        "max_key_age_days": 30,
    }
    assert sent(seen[2]) == {"disabled": True}
    assert [(r.method, r.url.path) for r in seen[1:]] == [
        ("GET", "/api/v1/admin/service-accounts"),
        ("PATCH", "/api/v1/admin/service-accounts/reporting"),
        ("DELETE", "/api/v1/admin/service-accounts/reporting"),
    ]


def test_a_new_key_is_printed_once_with_the_sentence_that_it_will_not_be_shown_again(
    serve: Serve,
) -> None:
    key = {
        "id": "k1",
        "prefix": "pbmb_sk_ab",
        "expires_at": "2026-11-25T00:00:00Z",
        "key": "pbmb_sk_abcdef-secret",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return json_response(200, {"service_accounts": [ACCOUNT]})
        return json_response(201, key)

    seen = serve(handler)

    result = run("sa", "keys", "create", "reporting")

    assert result.exit_code == 0
    assert result.stdout == "pbmb_sk_abcdef-secret\n"
    assert "will not be shown again" in result.stderr
    assert "pbmb_sk_abcdef-secret" not in result.stderr
    assert sent(seen[-1]) == {"expires_in_days": 30}

    explicit = run(
        "sa", "keys", "create", "reporting", "--expires-in-days", "7", "--json"
    )
    assert json.loads(explicit.stdout)["key"] == "pbmb_sk_abcdef-secret"
    assert sent(seen[-1]) == {"expires_in_days": 7}


def test_keys_list_never_shows_a_key_and_revoke_names_the_key(serve: Serve) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(204)
        return json_response(
            200,
            {
                "keys": [
                    {
                        "id": "k1",
                        "prefix": "pbmb_sk_ab",
                        "expires_at": "2026-11-25T00:00:00Z",
                    }
                ]
            },
        )

    seen = serve(handler)

    assert "pbmb_sk_ab" in run("sa", "keys", "list", "reporting").stdout
    assert run("sa", "keys", "revoke", "reporting", "k1").exit_code == 0
    assert (seen[1].method, seen[1].url.path) == (
        "DELETE",
        "/api/v1/admin/service-accounts/reporting/keys/k1",
    )


def test_the_apis_sentence_and_exit_code_reach_the_user(serve: Serve) -> None:
    serve(lambda request: api_error(403, "refused", "You are not an admin."))

    result = run("admin", "status")

    assert result.exit_code == 4
    assert result.stderr == "You are not an admin.\n"


def test_people_invite_sends_email_and_role(serve: Serve) -> None:
    answer = {
        "invites": [
            {
                "id": "invite-1",
                "email": "reader@sample.example",
                "expires_at": "2026-11-15T00:00:00Z",
                "link": None,
            }
        ]
    }
    seen = serve(lambda request: json_response(200, answer))
    result = run(
        "admin",
        "people",
        "invite",
        "reader@sample.example",
        "--role",
        "viewer",
        "--json",
    )
    assert result.exit_code == 0, result.output
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/v1/admin/people/invites"
    assert sent(seen[0]) == {
        "emails": ["reader@sample.example"],
        "role": "viewer",
        "delivery": "email",
    }
    assert json.loads(result.stdout) == answer


def test_bare_people_keeps_its_json_output(serve: Serve) -> None:
    answer = {"people": []}
    seen = serve(lambda request: json_response(200, answer))
    result = run("admin", "people", "--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == answer
    assert len(seen) == 1
    assert seen[0].url.path == "/api/v1/admin/people"
