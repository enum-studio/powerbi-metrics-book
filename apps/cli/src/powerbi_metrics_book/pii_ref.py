from dataclasses import dataclass


@dataclass(frozen=True)
class PiiReference:
    kind: str
    table: str
    name: str | None


def parse_ref(reference: str, measure: bool = False) -> PiiReference:
    """Parse a Power BI table, column or measure reference."""
    try:
        table, remainder = _table(reference)
        if not remainder:
            if measure:
                raise ValueError
            return PiiReference("table", table, None)
        name, end = _bracketed(remainder, 0)
        if end != len(remainder):
            raise ValueError
        return PiiReference("measure" if measure else "column", table, name)
    except ValueError as error:
        raise ValueError(
            "Use Table[Column], 'Table Name'[Column], or Table for a whole table."
        ) from error


def _table(reference: str) -> tuple[str, str]:
    if reference.startswith("'"):
        chars: list[str] = []
        index = 1
        while index < len(reference):
            if reference[index] == "'":
                if index + 1 < len(reference) and reference[index + 1] == "'":
                    chars.append("'")
                    index += 2
                    continue
                table = "".join(chars)
                if not table:
                    raise ValueError
                return table, reference[index + 1 :] if index + 1 < len(
                    reference
                ) else ""
            chars.append(reference[index])
            index += 1
        raise ValueError
    opening = reference.find("[")
    if opening < 0:
        if not reference or any(char in reference for char in "]'"):
            raise ValueError
        return reference, ""
    table = reference[:opening]
    if not table or "'" in table or "]" in table:
        raise ValueError
    return table, reference[opening:]


def _bracketed(value: str, start: int) -> tuple[str, int]:
    if start >= len(value) or value[start] != "[":
        raise ValueError
    chars: list[str] = []
    index = start + 1
    while index < len(value):
        if value[index] == "]":
            if index + 1 < len(value) and value[index + 1] == "]":
                chars.append("]")
                index += 2
                continue
            name = "".join(chars)
            if name:
                return name, index + 1
            raise ValueError
        chars.append(value[index])
        index += 1
    raise ValueError
