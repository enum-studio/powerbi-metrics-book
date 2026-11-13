"""published_ports.py BASE OVERLAY [SERVICE ...]

Fails unless the services named are the only ones that publish a port once
OVERLAY is layered over BASE. It reads the files the way compose merges them:
an overlay's ports are added to the base's, unless the overlay resets them
with `!reset`. It never resolves a variable, so it prints no value from .env;
`docker compose config` would, which is why it is not used here.
"""

import sys
from pathlib import Path

import yaml


class Reset(list[object]):
    """A list the overlay tagged !reset: it replaces the base's."""


class Loader(yaml.SafeLoader):
    pass


def _reset(loader: yaml.SafeLoader, node: yaml.Node) -> Reset:
    if isinstance(node, yaml.SequenceNode):
        return Reset(loader.construct_sequence(node))
    return Reset()


Loader.add_constructor("!reset", _reset)
Loader.add_constructor("!override", _reset)


def ports_by_service(path: str) -> dict[str, list[object] | None]:
    """Each service's ports as written, None where it names none."""
    document = yaml.load(Path(path).read_text(encoding="utf-8"), Loader=Loader)
    found: dict[str, list[object] | None] = {}
    for name, service in (document.get("services") or {}).items():
        ports = (service or {}).get("ports")
        found[name] = None if ports is None else ports
    return found


def published(base: str, overlay: str) -> dict[str, list[object]]:
    under, over = ports_by_service(base), ports_by_service(overlay)
    merged: dict[str, list[object]] = {}
    for name in under.keys() | over.keys():
        # An empty !reset is falsy, so it is told apart by its type, not with or.
        before, after = under.get(name), over.get(name)
        if isinstance(after, Reset):
            ports = list(after)
        else:
            ports = [*(before or []), *(after or [])]
        if ports:
            merged[name] = ports
    return merged


def main() -> int:
    base, overlay, *allowed = sys.argv[1:]
    found = published(base, overlay)
    unexpected = {name: found[name] for name in sorted(found) if name not in allowed}
    for name, ports in unexpected.items():
        print(f"{overlay}: {name} publishes {ports}; only {allowed or 'nothing'} may.")
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
