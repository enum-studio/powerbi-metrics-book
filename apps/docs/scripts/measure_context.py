# /// script
# requires-python = ">=3.11"
# dependencies = ["tiktoken==0.12.0"]
# ///
"""Count the tool-reply text used in the context guide."""

import csv
import io
import json
import sys

import tiktoken


def main() -> None:
    encoding = tiktoken.get_encoding("o200k_base")

    def tokens(text: str) -> int:
        return len(encoding.encode_ordinary(text))

    sample = json.load(sys.stdin)
    metrics = sample["metrics"]
    full = tokens(metrics["full_list"])
    short = tokens(metrics["short_list"])
    one = tokens(metrics["one_detail"])
    print(
        f"{metrics['count']} metrics: all details {full:,}; list {short:,}; "
        f"one detail {one:,}; list and one detail {short + one:,}."
    )
    print("Rows | All rows inline | Preview + link | Link only | CSV text")
    for case in sample["results"]:
        result = json.loads(case["inline"])
        table = io.StringIO(newline="")
        writer = csv.writer(table)
        writer.writerow([column["name"] for column in result["columns"]])
        writer.writerows(result["preview"])
        assert len(result["preview"]) == result["row_count"] == case["count"]
        print(
            f"{case['count']:,} | {tokens(case['inline']):,} | "
            f"{tokens(case['preview']):,} | {tokens(case['download_only']):,} | "
            f"{tokens(table.getvalue()):,}"
        )


if __name__ == "__main__":
    main()
