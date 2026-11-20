import json
import subprocess
from pathlib import Path
from typing import Annotated

import jsonschema
import typer
import yaml

from powerbi_metrics_book.conventions_file import YamlLoader, read_conventions
from powerbi_metrics_book.deployment import ASSETS, REQUIRED_ENV
from powerbi_metrics_book.output import FAILED, JsonOption, Settings

DOCKER_TIMEOUT_SECONDS = 300
# The last lines of Cerbos's output say which policy or test failed.
CERBOS_LINES_SHOWN = 25

type Step = tuple[str, list[str]]


def command(
    context: typer.Context,
    directory: Annotated[
        Path, typer.Argument(file_okay=False, help="The deployment directory.")
    ] = Path("."),
    json_output: JsonOption = False,
) -> None:
    """Check a deployment directory before you start it.

    Validates book.yml and conventions.yml when present against the shipped
    schemas, checks
    that .env holds every bootstrap value and is readable by you only, then
    runs your Cerbos policy tests in the pinned Cerbos image through Docker,
    with the default policies underneath. Local: it does not call the api and
    never prints a value from .env. Exits 1 when a step fails.
    """
    steps: list[Step] = [
        ("book.yml", _check_book(directory / "book.yml")),
        ("conventions.yml", _check_conventions(directory / "conventions.yml")),
        (".env", _check_env(directory / ".env")),
        ("policy tests", _check_policies(directory)),
    ]
    ok = not any(problems for _name, problems in steps)
    if context.ensure_object(Settings).as_json or json_output:
        typer.echo(
            json.dumps(
                {
                    "ok": ok,
                    "steps": [
                        {"name": name, "problems": problems} for name, problems in steps
                    ],
                },
                indent=2,
            )
        )
    else:
        for name, problems in steps:
            typer.echo(f"{'FAIL' if problems else 'ok  '} {name}")
            for problem in problems:
                typer.echo(f"     {problem}")
    if not ok:
        raise typer.Exit(FAILED)


def _check_book(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        document = yaml.load(path.read_text(encoding="utf-8"), Loader=YamlLoader)
    except yaml.YAMLError as error:
        return [f"book.yml is not valid YAML: {error}"]
    schema = json.loads((ASSETS / "book.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    return [
        f"book.yml{''.join(f'.{step}' for step in error.absolute_path)}: "
        f"{error.message}"
        for error in sorted(validator.iter_errors(document), key=str)
    ]


def _check_conventions(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        document = read_conventions(path)
    except typer.BadParameter as error:
        return [str(error)]
    schema = json.loads((ASSETS / "conventions.schema.json").read_text())
    return [
        f"conventions.yml{''.join(f'.{step}' for step in error.absolute_path)}: "
        f"{error.message}"
        for error in sorted(
            jsonschema.Draft202012Validator(schema).iter_errors(document), key=str
        )
    ]


def _check_env(path: Path) -> list[str]:
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        return [".env is missing. Run `pbmb init` for a new deployment."]
    problems = []
    if mode & 0o077:
        problems.append(f"{path} can be read by other users. Run `chmod 600 {path}`.")
    given = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and not line.lstrip().startswith("#"):
            given[name.strip()] = value.strip()
    problems += [
        f".env has no value for {name}. Set it in {path}."
        for name in REQUIRED_ENV
        if not given.get(name)
    ]
    return problems


def _check_policies(directory: Path) -> list[str]:
    policies, tests = directory / "access/policies", directory / "access/tests"
    # A link could point the container's read-only mount at any folder.
    linked = [str(found) for found in (policies, tests) if found.is_symlink()]
    if linked:
        return [f"{', '.join(linked)} is a symbolic link; make it a real folder."]
    root = directory.resolve()
    outside = [
        str(found)
        for found in (policies, tests)
        if not found.resolve().is_relative_to(root)
    ]
    if outside:
        return [f"{', '.join(outside)} points outside {directory}; keep it inside."]
    missing = [str(found) for found in (policies, tests) if not found.is_dir()]
    if missing:
        return [f"{', '.join(missing)} is missing. Run `pbmb init` for a new one."]
    compose = yaml.safe_load((ASSETS / "compose.yml").read_text(encoding="utf-8"))
    image = compose["services"]["cerbos"]["image"]
    arguments = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--volume",
        f"{(ASSETS / 'policies').resolve()}:/policies/default:ro",
        "--volume",
        f"{policies.resolve()}:/policies/deployment:ro",
        "--volume",
        f"{tests.resolve()}:/tests:ro",
        image,
        "compile",
        "--tests=/tests",
        "/policies",
    ]
    try:
        done = subprocess.run(
            arguments,
            capture_output=True,
            text=True,
            timeout=DOCKER_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        return ["Docker is not installed. Install Docker to run the policy tests."]
    except subprocess.TimeoutExpired:
        return [
            f"Docker did not finish in {DOCKER_TIMEOUT_SECONDS} seconds. "
            "Is the Docker daemon running and out of memory?"
        ]
    if done.returncode == 0:
        return []
    output = (done.stdout + done.stderr).strip().splitlines()
    return [
        f"The policy tests failed (docker exited {done.returncode}):",
        *output[-CERBOS_LINES_SHOWN:],
    ]
