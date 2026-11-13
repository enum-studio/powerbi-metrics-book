"""Copies what `pbmb init`, `pbmb check` and `pbmb curate` ship from where it
lives in this repository into the package, so the wheel carries it.

    uv run python apps/cli/scripts/sync_assets.py           # copy
    uv run python apps/cli/scripts/sync_assets.py --check   # fail if a copy is stale

The copies are checked in, and the --check run is part of the CLI's checks, so
a change to stack/compose.yml cannot ship without its copy.
"""

import argparse
import shutil
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[3]
ASSETS = REPOSITORY / "apps/cli/src/powerbi_metrics_book/assets"

# One entry per file or folder: where it lives, then where its copy goes under
# assets/. A folder is copied whole, so a policy added to access/policies/ is
# picked up without editing this list.
SOURCES = {
    "stack/compose.yml": "compose.yml",
    "stack/env.example": "env.example",
    "stack/cerbos/config.yaml": "cerbos/config.yaml",
    "stack/postgres/init": "postgres/init",
    "access/policies": "policies",
    "apps/api/src/services/admin/book.schema.json": "book.schema.json",
    "skills/curate_metrics_book/SKILL.md": "curation_brief.md",
}


def expected_files() -> dict[Path, Path]:
    """Every copy that should exist, mapped to the file it copies."""
    copies: dict[Path, Path] = {}
    for source_name, target_name in SOURCES.items():
        source = REPOSITORY / source_name
        if source.is_dir():
            for found in sorted(source.rglob("*")):
                if found.is_file():
                    copies[ASSETS / target_name / found.relative_to(source)] = found
        else:
            copies[ASSETS / target_name] = source
    return copies


def stale(copies: dict[Path, Path]) -> list[Path]:
    """Copies that are missing or differ, and copies whose source is gone."""
    problems = [
        target
        for target, source in copies.items()
        if not target.is_file() or target.read_bytes() != source.read_bytes()
    ]
    for target_name in SOURCES.values():
        folder = ASSETS / target_name
        if folder.is_dir():
            problems += [
                found
                for found in sorted(folder.rglob("*"))
                if found.is_file() and found not in copies
            ]
    return problems


def sync(copies: dict[Path, Path]) -> None:
    for target_name in SOURCES.values():
        if (ASSETS / target_name).is_dir():
            shutil.rmtree(ASSETS / target_name)
    for target, source in copies.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="store_true", help="Change nothing; fail if a copy is stale."
    )
    arguments = parser.parse_args()
    copies = expected_files()
    if arguments.check:
        problems = stale(copies)
        for path in problems:
            print(f"{path.relative_to(REPOSITORY)} is out of date", file=sys.stderr)
        if problems:
            print(
                "Run `uv run python apps/cli/scripts/sync_assets.py` and commit.",
                file=sys.stderr,
            )
        return 1 if problems else 0
    sync(copies)
    print(f"Copied {len(copies)} files into {ASSETS.relative_to(REPOSITORY)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
