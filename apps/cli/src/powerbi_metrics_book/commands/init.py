import json
import os
import re
import secrets
import shutil
import string
from importlib.metadata import version
from pathlib import Path
from typing import Annotated

import typer

from powerbi_metrics_book.deployment import ASSETS, PASSWORDS
from powerbi_metrics_book.output import FAILED, JsonOption, Settings

IMAGE = "ghcr.io/enum-studio/powerbi-metrics-book"
# Written when the release workflow publishes the image: `sha256:` and the
# digest of the image that matches this version of pbmb.
IMAGE_LOCK = ASSETS / "image.lock"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
PINNED_IMAGE = re.compile(r"[^\s@]+@sha256:[0-9a-f]{64}")

# Letters and digits only: each password goes into a database URL in compose.yml.
PASSWORD_ALPHABET = string.ascii_letters + string.digits
PASSWORD_LENGTH = 40

# What compose.yml says today, replaced by the pinned image. If the stack
# changes shape, init stops here instead of writing a broken file.
BUILT_IMAGE = "image: &image powerbi-metrics-book"
BUILD_BLOCK = """    build:
      context: ..
      dockerfile: apps/api/Dockerfile
      args: [GIT_SHA]
"""

BEGIN = "<!-- powerbi-metrics-book:begin -->"
END = "<!-- powerbi-metrics-book:end -->"

AGENTS = f"""# This deployment

{BEGIN}
`pbmb init` wrote this block. Write your own notes below it.

- Start: `docker compose up -d` here, after `PUBLIC_BASE_URL` in `.env` is the
  https address of the reverse proxy in front of the api (it listens on
  127.0.0.1 only).
- Check: `pbmb check` (`.env`, `book.yml`, `conventions.yml`, and the policy
  tests in `access/tests/`); `pbmb admin status` for the running deployment.
- Upgrade: change the image tag and its `@sha256:` digest in `compose.yml`
  together, read the release notes for changes to this directory, then
  `docker compose pull && docker compose up -d`. The api migrates at start.
- Settings are in Postgres: the admin section or `pbmb admin settings get|set`.
  `pbmb admin export -o book.yml` and `import book.yml` move them through git.
- Secrets are never in these files: a person runs
  `pbmb admin secrets set <name>`. Do not read, print or commit `.env`.
- Your Cerbos policies go in `access/policies/`, their tests in `access/tests/`.
{END}
"""

READMES = {
    "access/policies": "Your own Cerbos policies (.yaml) go here, layered on the "
    "defaults the image ships. A change needs `docker compose restart cerbos`.\n",
    "access/tests": "Tests (*_test.yaml) for your own policies go here. "
    "`pbmb check` runs them.\n",
}


class InitError(Exception):
    pass


def pinned_image(given: str | None) -> str:
    """The image reference compose.yml will run: --image, else this version's
    tag with the digest in image.lock. Always with a digest."""
    if given is not None:
        if not PINNED_IMAGE.fullmatch(given):
            raise InitError(
                "--image must name the image with its digest, such as "
                f"{IMAGE}:1.0.0@sha256:<64 hex digits>."
            )
        return given
    if not IMAGE_LOCK.is_file():
        raise InitError(
            "This build of pbmb has no image digest to pin, and a deployment "
            "must not run an image by tag alone. Install a released pbmb, or "
            f"pass --image {IMAGE}:<version>@sha256:<digest>."
        )
    digest = IMAGE_LOCK.read_text(encoding="utf-8").strip()
    if not DIGEST.fullmatch(digest):
        raise InitError(
            "The bundled image.lock does not hold a sha256 digest. This is a bug "
            "in powerbi-metrics-book; please report it."
        )
    return f"{IMAGE}:{version('powerbi-metrics-book')}@{digest}"


def compose_text(image: str) -> str:
    text = (ASSETS / "compose.yml").read_text(encoding="utf-8")
    if BUILT_IMAGE not in text or BUILD_BLOCK not in text:
        raise InitError(
            "The bundled compose.yml no longer has the shape pbmb init expects. "
            "This is a bug in powerbi-metrics-book; please report it."
        )
    return text.replace(BUILD_BLOCK, "").replace(BUILT_IMAGE, f"image: &image {image}")


def env_text(public_base_url: str) -> str:
    """env.example with a random value for each password and AUTH_SECRET."""
    lines = (ASSETS / "env.example").read_text(encoding="utf-8").split("\n")
    values = {
        "PUBLIC_BASE_URL": public_base_url,
        "AUTH_SECRET": secrets.token_hex(32),
        **{
            name: "".join(
                secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH)
            )
            for name in PASSWORDS
        },
    }
    for name, value in values.items():
        at = [number for number, line in enumerate(lines) if line == f"{name}="]
        if len(at) != 1:
            raise InitError(
                f"The bundled env.example has no single empty {name}= line. "
                "This is a bug in powerbi-metrics-book; please report it."
            )
        lines[at[0]] = f"{name}={value}"
    return "\n".join(lines)


def command(
    context: typer.Context,
    directory: Annotated[
        Path, typer.Argument(file_okay=False, help="Where to write the deployment.")
    ],
    url: Annotated[
        str,
        typer.Option(
            "--public-base-url",
            help="The https address people will open. Leave it out to set "
            "PUBLIC_BASE_URL in .env yourself; `pbmb check` reminds you.",
        ),
    ] = "",
    image: Annotated[
        str | None,
        typer.Option(
            help="The core image with its digest (name:tag@sha256:...). "
            "Default: this version's, from the digest bundled with a release."
        ),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Write a deployment directory: compose.yml, .env, access/ and AGENTS.md.

    Needs an empty or missing directory, owned by you and not writable by
    others, and changes nothing else. `.env` holds the bootstrap values with
    new random passwords and AUTH_SECRET, readable by you only; it is
    git-ignored, so keep a copy somewhere safe: without it the database cannot
    be reached again. Local: it does not call the api.
    """
    try:
        _check_directory(directory)
        _write(directory, url, pinned_image(image))
    except InitError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(FAILED) from error
    if context.ensure_object(Settings).as_json or json_output:
        typer.echo(json.dumps({"directory": str(directory)}, indent=2))
        return
    typer.echo(
        f"Wrote a deployment to {directory}. Next: cd {directory}, set "
        "PUBLIC_BASE_URL in .env if you did not pass --public-base-url, run "
        "`pbmb check`, then `docker compose up -d`."
    )


def _check_directory(directory: Path) -> None:
    if not directory.exists():
        return
    info = directory.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise InitError(
            f"{directory} must be owned by you and not writable by its group or "
            f"others, since it will hold the database passwords. Run "
            f"`chmod go-w {directory}`, or pass a new directory."
        )
    if any(directory.iterdir()):
        raise InitError(
            f"{directory} is not empty. Pass an empty or new directory, or run "
            "`pbmb check` to check the deployment already there."
        )


def _write(directory: Path, public_base_url: str, image: str) -> None:
    if re.search(r"\s", public_base_url):
        raise InitError("--public-base-url must be an address without spaces.")
    compose, env = compose_text(image), env_text(public_base_url)
    try:
        _write_files(directory, compose, env)
    except OSError as error:
        raise InitError(
            f"Cannot write {directory}: {error.strerror or error}. Remove what "
            "was written and run init again."
        ) from error


def _write_files(directory: Path, compose: str, env: str) -> None:
    if not directory.exists():
        directory.parent.mkdir(parents=True, exist_ok=True)
        # No exist_ok: a directory that appeared since the check is refused.
        directory.mkdir(mode=0o700)
    (directory / "compose.yml").write_text(compose, encoding="utf-8")
    shutil.copytree(ASSETS / "cerbos", directory / "cerbos")
    shutil.copytree(ASSETS / "postgres", directory / "postgres")
    for relative, line in READMES.items():
        (directory / relative).mkdir(parents=True)
        (directory / relative / "README.md").write_text(line, encoding="utf-8")
    (directory / ".gitignore").write_text(
        ".env\ncuration_progress.md\n", encoding="utf-8"
    )
    (directory / "conventions.yml").write_text(
        "# https://powerbimetricsbook.io/docs/make-it-yours/conventions/\n"
        "format: 1\npreset: metrics_book\n",
        encoding="utf-8",
    )
    (directory / "AGENTS.md").write_text(AGENTS, encoding="utf-8")
    # Created with mode 0600, never made readable and then narrowed.
    descriptor = os.open(
        directory / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        file.write(env)
