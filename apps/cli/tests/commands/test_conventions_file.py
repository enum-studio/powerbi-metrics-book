import json
from pathlib import Path

import httpx
import pytest
import yaml
from cli_support import Serve, json_response
from commands_support import run, sent


@pytest.mark.parametrize(
    "tail",
    [
        "",
        "exceptions: [] # keep\n",
        "exceptions: # keep\n  - rule: naming.case\n"
        "    metric: old\n    reason: Existing\n",
    ],
)
def test_baseline_preserves_comments_and_applies_file(
    serve: Serve, tmp_path: Path, tail: str
) -> None:
    path = tmp_path / "conventions.yml"
    original = "format: 1 # version\npreset: minimal\n" + tail
    path.write_text(original)
    exception = {"rule": "naming.kinds", "metric": "gmv", "reason": "Before style"}

    def answer(request: httpx.Request) -> httpx.Response:
        body = sent(request)
        return json_response(
            200,
            {
                "changed_rules": ["naming.kinds"],
                "now_failing": {"naming.kinds": 1},
                "exceptions_added": [exception] if body["dry_run"] else [],
                "version": 2,
            },
        )

    seen = serve(answer)
    result = run(
        "conventions",
        "apply",
        str(path),
        "--baseline",
        "--reason",
        "Before style",
        "--yes",
    )
    assert result.exit_code == 0, result.output
    assert "# version" in path.read_text()
    if tail:
        assert "# keep" in path.read_text()
    document = yaml.safe_load(path.read_text())
    assert exception in document["exceptions"]
    assert sent(seen[0])["baseline_reason"] == "Before style"
    assert sent(seen[-1]) == {"conventions": document, "dry_run": False}


@pytest.mark.parametrize(
    "document",
    [
        "preset: minimal\n",
        "format: 1\noff: &rules []\n",
        "format: 1\nguide: ../outside.md\n",
    ],
)
def test_apply_refuses_invalid_local_file_before_request(
    serve: Serve, tmp_path: Path, document: str
) -> None:
    path = tmp_path / "conventions.yml"
    path.write_text(document)
    seen = serve(lambda request: json_response(200, {}))
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 2
    assert seen == []


def test_diff_company_part_exits_for_difference(serve: Serve, tmp_path: Path) -> None:
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\nnaming:\n  case: none\n")
    serve(
        lambda request: json_response(
            200,
            {"rules": [{"id": "naming.case"}]}
            if request.url.path.endswith("/rules")
            else {"format": 1, "naming": {"case": "snake_case"}},
        )
    )
    result = run("conventions", "diff", str(path))
    assert result.exit_code == 1
    assert "naming.case" in result.stdout
    path.write_text("format: 1\nnaming:\n  case: snake_case\n")
    assert run("conventions", "diff", str(path)).exit_code == 0


def test_export_apply_round_trip_and_no_change(serve: Serve, tmp_path: Path) -> None:
    document = {
        "format": 1,
        "preset": "minimal",
        "guide": "Our guide.",
        "naming": {"case": "none"},
    }

    def answer(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return json_response(200, document)
        assert sent(request)["conventions"] == document
        return json_response(
            200,
            {
                "changed_rules": [],
                "now_failing": {},
                "exceptions_added": [],
                "version": 2,
            },
        )

    seen = serve(answer)
    path = tmp_path / "conventions.yml"
    assert run("conventions", "export", "--output", str(path)).exit_code == 0
    assert path.read_text().startswith("format: 1\npreset: minimal\n")
    assert (tmp_path / "conventions/guide.md").read_text() == "Our guide."
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 0
    assert "No change." in result.stdout
    assert len(seen) == 2


def test_reset_removes_only_named_rule(serve: Serve) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rules"):
            return json_response(200, {"rules": [{"id": "naming.case"}]})
        if request.url.path.endswith("/company"):
            return json_response(
                200,
                {
                    "format": 1,
                    "naming": {"case": "none", "kinds": []},
                    "off": ["naming.case", "naming.kinds"],
                    "exceptions": [
                        {"rule": "naming.case", "metric": "a", "reason": "Old"},
                        {"rule": "naming.kinds", "metric": "a", "reason": "Old"},
                    ],
                },
            )
        assert sent(request)["conventions"] == {
            "format": 1,
            "naming": {"kinds": []},
            "off": ["naming.kinds"],
            "exceptions": [{"rule": "naming.kinds", "metric": "a", "reason": "Old"}],
        }
        return json_response(
            200,
            {
                "changed_rules": ["naming.case"],
                "now_failing": {},
                "exceptions_added": [],
                "version": 2,
            },
        )

    serve(answer)
    assert run("conventions", "reset", "naming.case", "--yes").exit_code == 0


def test_baseline_restores_unsupported_flow_mapping(
    serve: Serve, tmp_path: Path
) -> None:
    path = tmp_path / "conventions.yml"
    original = "{format: 1, exceptions: []}\n"
    path.write_text(original)
    seen = serve(
        lambda request: json_response(
            200,
            {
                "changed_rules": ["naming.kinds"],
                "now_failing": {},
                "exceptions_added": [
                    {"rule": "naming.kinds", "metric": "gmv", "reason": "Old"}
                ],
                "version": 1,
            },
        )
    )
    result = run(
        "conventions", "apply", str(path), "--baseline", "--reason", "Old", "--yes"
    )
    assert result.exit_code == 2
    assert "by hand" in result.output
    assert path.read_text() == original
    assert len(seen) == 1


def test_baseline_dry_run_and_second_run_do_not_write(
    serve: Serve, tmp_path: Path
) -> None:
    path = tmp_path / "conventions.yml"
    original = "format: 1 # keep\n"
    path.write_text(original)
    answer = {
        "changed_rules": [],
        "now_failing": {},
        "exceptions_added": [],
        "version": 1,
    }
    seen = serve(lambda request: json_response(200, answer))
    for flags in [("--dry-run",), ("--yes",)]:
        result = run(
            "conventions",
            "apply",
            str(path),
            "--baseline",
            "--reason",
            "Old",
            "--json",
            *flags,
        )
        assert result.exit_code == 0
        assert json.loads(result.stdout) == answer
        assert path.read_text() == original
    assert len(seen) == 2


def test_admin_import_refuses_two_sources_before_request(
    serve: Serve, tmp_path: Path
) -> None:
    book = tmp_path / "book.yml"
    book.write_text("format: 1\nconventions: {}\n")
    (tmp_path / "conventions.yml").write_text("format: 1\n")
    seen = serve(lambda request: json_response(200, {}))
    assert run("admin", "import", str(book), "--yes").exit_code == 2
    assert seen == []


def test_metrics_check_reports_unused(serve: Serve) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/unused"):
            assert request.url.params["metric"] == "gmv"
            return json_response(
                200,
                {
                    "unused": [
                        {
                            "rule": "naming.kinds",
                            "target": {"metric": "gmv"},
                            "reason": "Old",
                            "why": "passes",
                        }
                    ]
                },
            )
        return json_response(200, {"checks": []})

    serve(answer)
    result = run("metrics", "check", "gmv")
    assert result.exit_code == 1
    assert "conventions.exception_unused" in result.stdout


def test_admin_export_and_import_use_company_file(serve: Serve, tmp_path: Path) -> None:
    company = {"format": 1, "preset": "minimal", "guide": "The guide."}

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/company"):
            return json_response(200, company)
        if request.url.path.endswith("/export"):
            return json_response(
                200, {"yaml": "format: 1\nconventions:\n  preset: minimal\n"}
            )
        if request.url.path.endswith("/apply"):
            assert sent(request) == {"conventions": company, "dry_run": False}
            return json_response(
                200,
                {
                    "changed_rules": [],
                    "now_failing": {},
                    "exceptions_added": [],
                    "version": 1,
                },
            )
        return json_response(200, {"changes": []})

    seen = serve(answer)
    book = tmp_path / "book.yml"
    assert run("admin", "export", "-o", str(book)).exit_code == 0
    assert "conventions:" not in book.read_text()
    assert (tmp_path / "conventions/guide.md").read_text() == "The guide."
    assert run("admin", "import", str(book), "--yes").exit_code == 0
    assert [request.url.path.rsplit("/", 1)[-1] for request in seen][-3:] == [
        "import",
        "import",
        "apply",
    ]


def test_check_conventions_offline_uses_schema_and_safe_paths(tmp_path: Path) -> None:
    from powerbi_metrics_book.commands.check import _check_conventions

    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\npreset: minimal\n")
    assert _check_conventions(path) == []
    path.write_text("format: 1\npreset: unknown\n")
    assert any(
        "conventions.yml.preset" in problem for problem in _check_conventions(path)
    )
    outside = tmp_path.parent / "guide.md"
    (tmp_path / "guide.md").symlink_to(outside)
    path.write_text("format: 1\nguide: guide.md\n")
    assert any("outside" in problem for problem in _check_conventions(path))
    path.write_text("format: 1\noff: &rules []\nexceptions: *rules\n")
    assert any("aliases" in problem for problem in _check_conventions(path))
