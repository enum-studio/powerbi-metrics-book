---
title: "For agents: queries and results"
description: Run DAX as the signed-in person, read the preview, page through the rows, download a CSV link, and stay inside the limits.
sidebar:
  order: 3
---

Run DAX through the book, not around it. A query runs as the person who asked, so Power BI applies that person's own rights and row-level security. The rows stay on the server. You get a preview and a result id, and you read more only when you need it.

The same service answers the MCP tool `execute_dax`, the REST route `POST /api/v1/queries` and `pbmb dax run`.

## Take the DAX from the book

Do not write the measure again. `get_metric` names the measure to use in each dataset (`measure_reference`, such as `[Net sales]`). `get_variant` gives that measure's DAX. Use the measure by name in your query and the dataset's own calculation runs. If a variant has `reads_selection`, it depends on a slicer on the report page, and the answer lists the columns you must filter in the query yourself.

A query for net sales by month in 2025 on the sample Sales dataset:

```dax
EVALUATE
SUMMARIZECOLUMNS(
    'Date'[Month],
    TREATAS({2025}, 'Date'[Year]),
    "Net sales", [Net sales]
)
ORDER BY 'Date'[Month]
```

To find columns to filter or group by, use `list_columns` (`pbmb columns list <dataset>`). To reuse DAX someone ran before, search the [query log](/docs/use/query-log/).

## Run it

```bash
pbmb dax run "Sales" --file net_sales_by_month.dax \
  --purpose "Net sales by month in 2025, for the board pack"
```

The dataset is the first argument, by name or id. Give the DAX with `--file <path>` or `--query <dax>`. A name that several datasets share is refused with their ids, so use an id then.

Always send `--purpose` (the MCP tool's `purpose`, at most 2,000 characters). It is one sentence on why you ask. It sits in the query log beside your DAX, which makes the log searchable by question and shows people what asked for their data.

What is checked before Power BI is called:

- The caller may query the dataset. A dataset the caller may not see answers as missing.
- The DAX is not empty, is at most 100 KB, and starts with `EVALUATE` or `DEFINE` after any comments. It is checked and never rewritten. Power BI parses the rest, and a DAX error comes back as Power BI's own sentence.
- The caller is inside the rate limit and the row budget (below).

A query takes 300 seconds at most.

## What you get back

You never get the whole result. You get an anchor:

| Field | Holds |
|---|---|
| `result_id` | The stored result, for paging and the CSV. |
| `query_id` | The query's entry in the query log. |
| `columns` | Each column's `name` and `type`. |
| `row_count`, `bytes` | The size of the full result. |
| `truncated`, `truncation_note` | `true` and Power BI's sentence when Power BI cut the rows off at a limit (100,000 rows, 1,000,000 values or 15 MB). |
| `preview`, `preview_note` | The first rows. `preview_note` says why the preview stopped early. |
| `next_offset` | Where the next page starts, or `null` when the preview was everything. |
| `csv_url`, `csv_url_expires_at` | A signed download link, valid for 15 minutes. |
| `expires_at` | When the stored result is deleted. |

The preview holds 20 rows by default (`results.preview_rows`). Ask for up to 100 with `preview_rows` (`--preview` in the CLI), and 0 if you only want the anchor. It never holds more than 16 KiB, and says so when it stops early.

## Page through the rows

```bash
pbmb results read <result_id> --offset 20 --limit 100
```

`read_query_result` is the MCP tool. A page holds at most 500 rows (`results.page_rows_max`) and 16 KiB. `next_offset` says where to continue and is `null` on the last page. Rows come back in the order Power BI returned them.

Read pages when you need to look at a few rows. If you need all of them, take the file.

## Take every row as a file

```bash
pbmb dax run "Sales" --file net_sales_by_month.dax \
  --purpose "Net sales by month in 2025" --csv net_sales_2025.csv
```

`--csv` runs the query and downloads the whole result in one command. It prints the path and the number of rows, not the rows. For a result you already have:

```bash
pbmb results csv <result_id> -o net_sales_2025.csv
```

The MCP tool `get_result_csv_link` returns a fresh link (`url`, `expires_at`). Download it yourself with `curl -o file.csv "<url>"`, so the rows go to a file and never through the model. The file is CSV (RFC 4180), UTF-8, with a header row. A text cell that a spreadsheet would read as a formula starts with an apostrophe.

## Results belong to whoever ran the query

Only the person or service account that ran a query can read its result, whatever the policies say. The result holds data under that person's row-level security. A stored result is deleted after `results.ttl_hours` (24 hours by default, 72 at most, and the worker deletes it within 15 minutes of expiry). An expired result answers with when it expired and its `query_id`. `get_query` (`pbmb queries show <query_id>`) returns the DAX so you can run it again.

## Limits

| Limit | Default | Setting |
|---|---|---|
| Queries a minute, for each caller | 60 | `queries.rate_per_minute` |
| Queries running at once, for each caller | 4 | none |
| Rows returned to one caller in 24 hours | 1,000,000 | `results.daily_row_budget` |

A running query holds 100,000 rows of the budget until it ends. Past the budget the answer names the time it frees up. The budget exists so that an agent in a loop cannot copy a model out row by row. If a job needs more, ask an admin to raise the setting. Do not split the job across accounts.

A service account runs queries only if an admin turned on `powerbi.service_account_queries`, and then as the app's own service principal. It is refused on a dataset with row-level security, because Power BI answers such a dataset only to a person.

If a query is refused because your Power BI connection is missing or expired, call `whoami` (`pbmb whoami`). It shows the state and the page where the person reconnects.

## Check

```bash
pbmb dax run "Sales" --query 'EVALUATE ROW("Test", 1)' --purpose "Check that queries work"
pbmb queries search "Check that queries work" --mine
```

The first command prints a preview with one row and a `result_id`. The second lists that query with status `succeeded`, one row, and your purpose. If the first is refused, the sentence says whether it was access, the connection, a limit or the DAX.
