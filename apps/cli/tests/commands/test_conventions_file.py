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
        if request.method == "GET":
            return json_response(200, yaml.safe_load(original))
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
    seen = serve(
        lambda request: json_response(
            200, {"format": 1} if request.method == "GET" else answer
        )
    )
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
        expected = (
            answer
            if "--dry-run" in flags
            else {key: value for key, value in answer.items() if key != "version"}
        )
        assert json.loads(result.stdout) == expected
        assert path.read_text() == original
    assert [request.method for request in seen] == ["POST", "POST", "GET"]


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
    assert "metric gmv: conventions.exception_unused" in result.stdout


def test_admin_export_and_import_use_company_file(serve: Serve, tmp_path: Path) -> None:
    company = {"format": 1, "preset": "minimal", "guide": "The guide."}

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/company"):
            return json_response(200, company)
        if request.url.path.endswith("/export"):
            return json_response(200, {"yaml": "format: 1\n"})
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
    assert [request.url.path.rsplit("/", 1)[-1] for request in seen][-2:] == [
        "import",
        "company",
    ]
    assert all(
        request.method == "GET" or request.url.path.endswith("/import")
        for request in seen
    )


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
    assert any(
        "no symbolic link on the way" in problem for problem in _check_conventions(path)
    )
    path.write_text("format: 1\noff: &rules []\nexceptions: *rules\n")
    assert any("aliases" in problem for problem in _check_conventions(path))


def test_off_and_yes_read_as_text_as_the_api_reads_them(tmp_path: Path) -> None:
    from powerbi_metrics_book.commands.check import _check_conventions
    from powerbi_metrics_book.conventions_file import read_conventions

    path = tmp_path / "conventions.yml"
    path.write_text(
        "format: 1\n"
        "off: [naming.qualifier_order]\n"
        "drafting:\n  name_hints:\n    currency: [yes, on, NO]\n"
    )
    assert _check_conventions(path) == []
    document = read_conventions(path)
    assert document["off"] == ["naming.qualifier_order"]
    assert document["drafting"] == {"name_hints": {"currency": ["yes", "on", "NO"]}}
    path.write_text("format: 1\ndataset_fields:\n  owner:\n    required: true\n")
    assert _check_conventions(path) == []
    assert read_conventions(path)["dataset_fields"] == {"owner": {"required": True}}


@pytest.mark.parametrize("command", ["conventions", "admin"])
@pytest.mark.parametrize(
    "link", ["conventions", "conventions/guide.md", "conventions.yml"]
)
def test_export_refuses_symlink_targets(
    serve: Serve, tmp_path: Path, command: str, link: str
) -> None:
    folder = tmp_path / "output"
    folder.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    protected = outside / "guide.md"
    protected.write_text("Keep this.")
    target = folder / link
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(outside if link == "conventions" else protected)
    serve(
        lambda request: json_response(
            200,
            {"yaml": "format: 1\n"}
            if request.url.path.endswith("/export")
            else {"format": 1, "guide": "Server guide."},
        )
    )
    result = run(
        command,
        "export",
        "--output",
        str(folder / ("book.yml" if command == "admin" else "conventions.yml")),
    )
    assert result.exit_code == 2, result.output
    assert str(target) in result.output
    if command == "admin":
        assert not (folder / "book.yml").exists()
    assert protected.read_text() == "Keep this."
    assert sorted(item.name for item in outside.iterdir()) == ["guide.md"]


@pytest.mark.parametrize(
    "key,value",
    [("guide", "New guide."), ("drafting", {"name_hints": {"currency": ["EUR"]}})],
)
def test_apply_non_rule_change_saves(
    serve: Serve, tmp_path: Path, key: str, value: object
) -> None:
    path = tmp_path / "conventions.yml"
    if key == "guide":
        (tmp_path / "guide.md").write_text(str(value))
    path.write_text(
        yaml.safe_dump({"format": 1, key: "guide.md" if key == "guide" else value})
    )
    seen = serve(
        lambda request: json_response(
            200,
            {"format": 1}
            if request.method == "GET"
            else {
                "changed_rules": [],
                "now_failing": {},
                "exceptions_added": [],
                "version": 2,
            },
        )
    )
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 0, result.output
    assert key in result.stdout
    assert any(
        request.method == "POST" and sent(request)["dry_run"] is False
        for request in seen
    )


@pytest.mark.parametrize(
    ("before", "after", "said"),
    [
        ("a" * 3800, "b" * 4100, "guide: changed (4.1 KB, was 3.8 KB)."),
        (None, "Short.", "guide: changed (6 bytes, was none)."),
    ],
)
def test_apply_preview_says_the_guide_size_before_and_after(
    serve: Serve, tmp_path: Path, before: str | None, after: str, said: str
) -> None:
    (tmp_path / "guide.md").write_text(after)
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\nguide: guide.md\n")
    current = {"format": 1} if before is None else {"format": 1, "guide": before}
    serve(
        lambda request: json_response(
            200,
            current
            if request.method == "GET"
            else {
                "changed_rules": [],
                "now_failing": {},
                "exceptions_added": [],
                "version": None,
            },
        )
    )
    result = run("conventions", "apply", str(path), input="n\n")
    assert said in result.output
    assert after not in result.output


def test_diff_exception_order_and_rule_reporting(serve: Serve, tmp_path: Path) -> None:
    first = {"rule": "naming.case", "metric": "one", "reason": "Old"}
    second = {"rule": "naming.kinds", "metric": "two", "reason": "Old"}
    company = {"format": 1, "exceptions": [first, second]}
    seen = serve(
        lambda request: json_response(
            200, {"rules": []} if request.url.path.endswith("/rules") else company
        )
    )
    path = tmp_path / "conventions.yml"
    path.write_text(yaml.safe_dump({**company, "exceptions": [second, first]}))
    assert run("conventions", "diff", str(path)).exit_code == 0
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 0
    assert "No change." in result.stdout
    assert all(request.method == "GET" for request in seen)
    path.write_text(yaml.safe_dump({**company, "exceptions": [first]}))
    result = run("conventions", "diff", str(path))
    assert result.exit_code == 1
    assert "exceptions.naming.kinds:" in result.stdout


@pytest.mark.parametrize("changed", [True, False])
def test_admin_import_previews_conventions_and_skips_equal(
    serve: Serve, tmp_path: Path, changed: bool
) -> None:
    book = tmp_path / "book.yml"
    book.write_text("format: 1\n")
    company = {"format": 1, "drafting": {"name_hints": {"currency": ["EUR"]}}}
    (tmp_path / "conventions.yml").write_text(yaml.safe_dump(company))

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/company"):
            return json_response(200, {"format": 1} if changed else company)
        if request.url.path.endswith("/import"):
            return json_response(200, {"changes": []})
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
    result = run("admin", "import", str(book), input="y\n")
    assert result.exit_code == 0, result.output
    posts = [sent(request) for request in seen if request.url.path.endswith("/apply")]
    assert posts == (
        [
            {"conventions": company, "dry_run": True},
            {"conventions": company, "dry_run": False},
        ]
        if changed
        else []
    )
    assert ("Apply these changes?" in result.stdout) == changed
    if changed:
        assert result.stdout.index("drafting") < result.stdout.index(
            "Apply these changes?"
        )


@pytest.mark.parametrize("global_json", [False, True])
def test_baseline_json_requires_yes_before_file_write(
    serve: Serve, tmp_path: Path, global_json: bool
) -> None:
    path = tmp_path / "conventions.yml"
    original = "format: 1 # keep\n"
    path.write_text(original)
    serve(
        lambda request: json_response(
            200,
            {
                "changed_rules": ["naming.case"],
                "now_failing": {},
                "exceptions_added": [
                    {"rule": "naming.case", "metric": "gmv", "reason": "Old"}
                ],
                "version": 2,
            },
        )
    )
    result = run(
        *(["--json"] if global_json else []),
        "conventions",
        "apply",
        str(path),
        "--baseline",
        "--reason",
        "Old",
        *([] if global_json else ["--json"]),
    )
    assert result.exit_code == 2
    assert path.read_text() == original


@pytest.mark.parametrize("count", [1, 2])
def test_baseline_dry_run_says_would_add(
    serve: Serve, tmp_path: Path, count: int
) -> None:
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\n")
    serve(
        lambda request: json_response(
            200,
            {
                "changed_rules": ["naming.case"],
                "now_failing": {},
                "exceptions_added": [
                    {
                        "rule": "naming.case",
                        "metric": f"metric_{index}",
                        "reason": "Old",
                    }
                    for index in range(count)
                ],
                "version": 2,
            },
        )
    )
    result = run(
        "conventions", "apply", str(path), "--baseline", "--reason", "Old", "--dry-run"
    )
    assert result.exit_code == 0
    assert f"Would add {count} exception{'s' if count != 1 else ''}." in result.stdout


def test_reset_unknown_rule(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"rules": [{"id": "naming.case"}]}))
    result = run("conventions", "reset", "unknown", "--yes")
    assert result.exit_code == 2
    assert "Unknown rule id: unknown" in result.output
    assert len(seen) == 1


def test_import_alias_note(serve: Serve, tmp_path: Path) -> None:
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\n")
    serve(
        lambda request: json_response(
            200,
            {"format": 1}
            if request.method == "GET"
            else {
                "changed_rules": [],
                "now_failing": {},
                "exceptions_added": [],
                "version": 1,
            },
        )
    )
    result = run("conventions", "import", str(path), "--yes")
    assert result.exit_code == 0
    assert "alias for apply for one release" in result.stderr


def test_export_resolved_guide_inline(serve: Serve, tmp_path: Path) -> None:
    document = {
        "preset": "minimal",
        "guide": "Resolved guide.",
        "rules": {"naming": {"case": "none"}},
    }
    serve(lambda request: json_response(200, document))
    path = tmp_path / "conventions.yml"
    result = run("conventions", "export", "--resolved", "--output", str(path))
    assert result.exit_code == 0, result.output
    assert yaml.safe_load(path.read_text()) == {
        "format": 1,
        "preset": "minimal",
        "guide": "Resolved guide.",
        "naming": {"case": "none"},
    }
    assert not (tmp_path / "conventions").exists()


@pytest.mark.parametrize(
    "book_changed,conventions_changed", [(False, True), (True, False), (False, False)]
)
def test_admin_import_separate_previews(
    serve: Serve, tmp_path: Path, book_changed: bool, conventions_changed: bool
) -> None:
    book = tmp_path / "book.yml"
    book.write_text("format: 1\n")
    company = {"format": 1, "drafting": {"name_hints": {"currency": ["EUR"]}}}
    (tmp_path / "conventions.yml").write_text(yaml.safe_dump(company))

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/company"):
            return json_response(200, {"format": 1} if conventions_changed else company)
        if request.url.path.endswith("/import"):
            return json_response(
                200,
                {
                    "changes": [
                        {"path": "settings.example", "before": None, "after": True}
                    ]
                    if book_changed
                    else []
                },
            )
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
    result = run("admin", "import", str(book), input="y\n")
    assert result.exit_code == 0, result.output
    conventions_preview, book_preview = result.stdout.split("Book:")
    assert "Conventions:" in conventions_preview
    assert ("No change." in conventions_preview) == (not conventions_changed)
    assert ("No change." in book_preview) == (not book_changed)
    changed = book_changed or conventions_changed
    assert ("Nothing to change: the deployment already matches." in result.stdout) == (
        not changed
    )
    assert ("Apply these changes?" in result.stdout) == changed
    if not changed:
        assert not any(
            request.method == "POST"
            for request in seen
            if not request.url.path.endswith("/import")
        )
        assert all(
            not sent(request)["apply"]
            for request in seen
            if request.url.path.endswith("/import")
        )


@pytest.mark.parametrize("current", [{"format": 1}, {"format": 1, "naming": None}])
def test_apply_empty_mapping_is_a_change(
    serve: Serve, tmp_path: Path, current: dict[str, object]
) -> None:
    path = tmp_path / "conventions.yml"
    path.write_text("format: 1\nnaming: {}\n")
    seen = serve(
        lambda request: json_response(
            200,
            current
            if request.method == "GET"
            else {
                "changed_rules": [],
                "now_failing": {},
                "exceptions_added": [],
                "version": 2,
            },
        )
    )
    result = run("conventions", "apply", str(path), "--yes")
    assert result.exit_code == 0, result.output
    assert "No change." not in result.stdout
    assert [
        sent(request)["dry_run"] for request in seen if request.method == "POST"
    ] == [True, False]


def test_resolved_export_ignores_guide_symlink(serve: Serve, tmp_path: Path) -> None:
    folder = tmp_path / "output"
    folder.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (folder / "conventions").symlink_to(outside)
    serve(
        lambda request: json_response(
            200, {"preset": "minimal", "guide": "Inline guide.", "rules": {}}
        )
    )
    path = folder / "conventions.yml"
    result = run("conventions", "export", "--resolved", "--output", str(path))
    assert result.exit_code == 0, result.output
    assert yaml.safe_load(path.read_text())["guide"] == "Inline guide."
    assert list(outside.iterdir()) == []


def test_reset_all_keeps_only_format_and_preset(serve: Serve) -> None:
    company = {
        "format": 1,
        "preset": "minimal",
        "naming": {"case": "none"},
        "off": ["naming.case"],
        "exceptions": [{"rule": "naming.case", "metric": "gmv", "reason": "Old"}],
        "drafting": {"name_hints": {"currency": ["EUR"]}},
        "guide": "Our guide.",
    }
    seen = serve(
        lambda request: json_response(
            200,
            company
            if request.method == "GET"
            else {
                "changed_rules": ["naming.case"],
                "now_failing": {},
                "exceptions_added": [],
                "version": 2,
            },
        )
    )
    result = run("conventions", "reset", "--yes")
    assert result.exit_code == 0, result.output
    assert [sent(request) for request in seen if request.method == "POST"] == [
        {"conventions": {"format": 1, "preset": "minimal"}, "dry_run": dry_run}
        for dry_run in [True, False]
    ]
