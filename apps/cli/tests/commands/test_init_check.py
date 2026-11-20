import importlib.util
import json
import shutil
import stat
from importlib.metadata import version
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from commands_support import run
from typer.testing import Result

from powerbi_metrics_book.commands import check, init
from powerbi_metrics_book.commands.init import BEGIN, END
from powerbi_metrics_book.deployment import PASSWORDS, REQUIRED_ENV

REPOSITORY = Path(__file__).resolve().parents[4]
EXAMPLE = REPOSITORY / "access/layering_tests/override"
DIGEST = "sha256:" + "ab" * 32
IMAGE = f"ghcr.io/enum-studio/powerbi-metrics-book:1.2.3@{DIGEST}"
ADDRESS = "https://metrics.sample-data.test"


def init_into(target: Path, *extra: str) -> Result:
    return run("init", str(target), "--image", IMAGE, *extra)


def values_of(env: Path) -> dict[str, str]:
    lines = env.read_text().splitlines()
    pairs = [line.partition("=") for line in lines if not line.startswith("#")]
    return {name: value for name, separator, value in pairs if separator}


def test_init_writes_the_deployment_directory_with_the_image_pinned_by_digest(
    tmp_path: Path,
) -> None:
    target = tmp_path / "deployment"

    result = init_into(target, "--public-base-url", ADDRESS)

    assert result.exit_code == 0
    compose = (target / "compose.yml").read_text()
    assert f"image: &image {IMAGE}\n" in compose
    assert "build:" not in compose
    assert (
        (target / "conventions.yml")
        .read_text()
        .endswith("format: 1\npreset: metrics_book\n")
    )
    assert (target / "cerbos/config.yaml").is_file()
    assert (target / "postgres/init/01_roles_and_database.sh").is_file()
    assert (target / ".gitignore").read_text().splitlines() == [
        ".env",
        "curation_progress.md",
    ]
    for folder in ("access/policies", "access/tests"):
        assert (target / folder / "README.md").read_text().strip()
    agents = (target / "AGENTS.md").read_text()
    assert agents.index(BEGIN) < agents.index("docker compose up") < agents.index(END)
    assert "tag and its `@sha256:` digest" in agents
    env = values_of(target / ".env")
    assert env["PUBLIC_BASE_URL"] == ADDRESS
    assert all(env[name] for name in REQUIRED_ENV)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700


def test_init_without_a_digest_refuses_and_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(init, "IMAGE_LOCK", tmp_path / "absent.lock")

    for arguments in (
        [],
        ["--image", "ghcr.io/x/y:1.0.0"],
        ["--image", "y@sha256:abc"],
    ):
        result = run("init", str(tmp_path / "d"), *arguments)
        assert result.exit_code == 1
        assert "digest" in result.stderr
    assert not (tmp_path / "d").exists()


def test_init_pins_this_versions_tag_with_the_digest_from_the_release_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = tmp_path / "image.lock"
    lock.write_text(DIGEST + "\n")
    monkeypatch.setattr(init, "IMAGE_LOCK", lock)

    assert run("init", str(tmp_path / "d")).exit_code == 0

    tag = version("powerbi-metrics-book")
    wanted = f"image: &image ghcr.io/enum-studio/powerbi-metrics-book:{tag}@{DIGEST}\n"
    assert wanted in (tmp_path / "d/compose.yml").read_text()

    lock.write_text("latest\n")
    assert run("init", str(tmp_path / "e")).exit_code == 1


def test_init_writes_env_readable_by_its_owner_only_with_new_random_values_each_run(
    tmp_path: Path,
) -> None:
    first, second = tmp_path / "first", tmp_path / "second"
    init_into(first)
    init_into(second)

    assert stat.S_IMODE((first / ".env").stat().st_mode) == 0o600
    one, two = values_of(first / ".env"), values_of(second / ".env")
    secret_names = (*PASSWORDS, "AUTH_SECRET")
    for name in secret_names:
        assert one[name] != two[name]
        assert len(one[name]) >= 32
    assert len({one[name] for name in secret_names}) == len(secret_names)
    assert all(one[name].isalnum() for name in PASSWORDS)


def test_init_refuses_a_directory_that_has_anything_in_it(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("keep me")

    result = init_into(tmp_path)

    assert result.exit_code == 1
    assert "is not empty" in result.stderr
    assert [found.name for found in tmp_path.iterdir()] == ["notes.txt"]


def test_init_refuses_a_directory_others_can_write_to(tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o775)

    result = init_into(shared)

    assert result.exit_code == 1
    assert "not writable by its group or others" in result.stderr
    assert list(shared.iterdir()) == []


def test_init_takes_an_empty_directory_and_refuses_an_address_with_spaces(
    tmp_path: Path,
) -> None:
    empty = tmp_path / "empty"
    empty.mkdir(mode=0o700)
    assert init_into(empty).exit_code == 0

    refused = init_into(tmp_path / "other", "--public-base-url", "a b\nINJECT=1")

    assert refused.exit_code == 1
    assert "without spaces" in refused.stderr
    assert not (tmp_path / "other/.env").exists()


def test_init_makes_missing_parents_and_turns_a_write_failure_into_a_sentence(
    tmp_path: Path,
) -> None:
    assert init_into(tmp_path / "a/b/c").exit_code == 0
    assert stat.S_IMODE((tmp_path / "a/b/c").stat().st_mode) == 0o700

    (tmp_path / "file").write_text("x")
    result = init_into(tmp_path / "file/d")

    assert result.exit_code == 1
    assert "Cannot write" in result.stderr
    assert "Traceback" not in result.stderr


def test_init_json_is_one_document(tmp_path: Path) -> None:
    result = init_into(tmp_path / "d", "--json")

    assert json.loads(result.stdout) == {"directory": str(tmp_path / "d")}


def test_a_book_yml_the_api_would_export_passes_and_a_wrong_one_names_the_problem(
    tmp_path: Path,
) -> None:
    book = tmp_path / "book.yml"
    book.write_text(
        "format: 1\nsettings:\n  results.ttl_hours: 48\n"
        "role_assignments:\n"
        "  - {role: admin, subject_kind: person, subject: a@sample-data.test}\n"
    )
    assert check._check_book(book) == []

    book.write_text(
        "format: 2\nextra: 1\n"
        "role_assignments:\n  - {role: admin, subject_kind: robot}\n"
    )
    problems = check._check_book(book)

    assert any(problem.startswith("book.yml.format") for problem in problems)
    assert any("role_assignments.0" in problem for problem in problems)
    assert any("extra" in problem for problem in problems)
    assert check._check_book(tmp_path / "absent.yml") == []


def test_env_problems_name_the_variable_and_never_the_value(tmp_path: Path) -> None:
    init_into(tmp_path / "d")
    env = tmp_path / "d/.env"
    assert check._check_env(env) == [
        f".env has no value for PUBLIC_BASE_URL. Set it in {env}."
    ]

    lines = [
        line for line in env.read_text().splitlines() if not line.startswith("AUTH_")
    ]
    env.write_text("\n".join(lines) + "\nAUTH_SECRET=\n")
    env.chmod(0o644)
    problems = check._check_env(env)

    assert any("can be read by other users" in problem for problem in problems)
    assert any("no value for AUTH_SECRET" in problem for problem in problems)
    leaked = [value for name, value in values_of(env).items() if name in PASSWORDS]
    assert not any(value in problem for problem in problems for value in leaked)


def test_check_refuses_policy_folders_that_are_symbolic_links(tmp_path: Path) -> None:
    init_into(tmp_path / "d")
    policies = tmp_path / "d/access/policies"
    shutil.rmtree(policies)
    policies.symlink_to(tmp_path, target_is_directory=True)

    assert check._check_policies(tmp_path / "d") == [
        f"{policies} is a symbolic link; make it a real folder."
    ]


def test_check_refuses_policy_folders_that_resolve_outside_the_deployment(
    tmp_path: Path,
) -> None:
    init_into(tmp_path / "d")
    (tmp_path / "d/access").rename(tmp_path / "elsewhere")
    (tmp_path / "d/access").symlink_to(tmp_path / "elsewhere", target_is_directory=True)

    [problem] = check._check_policies(tmp_path / "d")

    assert "points outside" in problem


def test_check_runs_cerbos_locked_down_with_read_only_mounts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    init_into(tmp_path / "d")
    calls: list[list[str]] = []

    def fake_run(arguments: list[str], **_options: object) -> CompletedProcess[str]:
        calls.append(arguments)
        return CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(check.subprocess, "run", fake_run)

    assert check._check_policies(tmp_path / "d") == []

    [arguments] = calls
    text = " ".join(arguments)
    for flag in (
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges",
        "--network none",
    ):
        assert flag in text
    mounts = [
        arguments[at + 1] for at, word in enumerate(arguments) if word == "--volume"
    ]
    assert len(mounts) == 3 and all(mount.endswith(":ro") for mount in mounts)
    assert "@sha256:" in text


def test_check_reports_every_step_and_exits_1_before_it_needs_docker(
    tmp_path: Path,
) -> None:
    (tmp_path / "book.yml").write_text("format: 2\n")
    (tmp_path / "conventions.yml").write_text("format: 2\n")

    result = run("check", str(tmp_path), "--json")

    assert result.exit_code == 1
    report = json.loads(result.stdout)
    assert report["ok"] is False
    assert [step["name"] for step in report["steps"]] == [
        "book.yml",
        "conventions.yml",
        ".env",
        "policy tests",
    ]
    assert all(step["problems"] for step in report["steps"])


@pytest.mark.docker
def test_check_passes_a_fresh_deployment(tmp_path: Path) -> None:
    target = tmp_path / "deployment"
    init_into(target, "--public-base-url", ADDRESS)

    result = run("check", str(target))

    assert result.exit_code == 0, result.stdout
    assert result.stdout.splitlines() == [
        "ok   book.yml",
        "ok   conventions.yml",
        "ok   .env",
        "ok   policy tests",
    ]


@pytest.mark.docker
def test_check_runs_the_deployments_policy_tests_on_top_of_the_defaults(
    tmp_path: Path,
) -> None:
    target = tmp_path / "deployment"
    init_into(target, "--public-base-url", ADDRESS)
    shutil.copytree(
        EXAMPLE / "policies", target / "access/policies", dirs_exist_ok=True
    )
    shutil.copytree(EXAMPLE / "tests", target / "access/tests", dirs_exist_ok=True)
    assert run("check", str(target)).exit_code == 0

    broken = target / "access/tests/admin_override_test.yaml"
    broken.write_text(broken.read_text().replace("EFFECT_ALLOW", "EFFECT_DENY"))
    result = run("check", str(target))

    assert result.exit_code == 1
    assert "FAIL policy tests" in result.stdout
    assert "admin_override" in result.stdout


def test_the_bundled_copies_are_checked_against_where_they_come_from(
    tmp_path: Path,
) -> None:
    spec = importlib.util.spec_from_file_location(
        "sync_assets", REPOSITORY / "apps/cli/scripts/sync_assets.py"
    )
    assert spec and spec.loader
    sync_assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync_assets)
    shutil.copytree(sync_assets.ASSETS, tmp_path / "assets")
    sync_assets.ASSETS = tmp_path / "assets"
    copies = sync_assets.expected_files()
    assert sync_assets.stale(copies) == []
    (tmp_path / "assets/image.lock").write_text(DIGEST)
    assert sync_assets.stale(copies) == []

    (tmp_path / "assets/compose.yml").write_text("changed")
    (tmp_path / "assets/policies/leftover.yaml").write_text("x")
    (tmp_path / "assets/cerbos/config.yaml").unlink()

    assert sorted(path.name for path in sync_assets.stale(copies)) == [
        "compose.yml",
        "config.yaml",
        "leftover.yaml",
    ]
