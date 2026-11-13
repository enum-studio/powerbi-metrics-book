---
title: The query log
description: What is recorded for every query, how to search it, and who can read which entry.
sidebar:
  order: 7
---

Every DAX query run through the book is logged once, whatever happened to it. The log answers three questions: has someone already asked this, who queried this metric, and what failed. It holds the query, never its answer.

## What is logged

One entry per query, written after the query ends, including queries refused before Power BI was called:

| Field | Holds |
|---|---|
| `id`, `at` | The entry's id (the `query_id` of the answer) and when the query started. |
| `principal`, `via`, `client_id` | Who ran it (a person or a service account), through what (`cli`, `mcp`, `api` or `browser`) and which client. |
| `dataset`, `workspace_id` | The dataset queried. Empty when the query was refused before a dataset was found. |
| `dax`, `purpose` | The DAX as sent, and the purpose the caller gave. |
| `status` | `succeeded`, `truncated` (Power BI cut the rows off), `failed` (Power BI answered an error) or `refused` (stopped before Power BI was asked: access, a limit, or invalid DAX). |
| `error` | The sentence the caller got, for a failed or refused query. |
| `row_count`, `column_count`, `duration_ms`, `result_id` | The size, the time, and the stored result. |
| `measure_names`, `metric_ids` | The measures the DAX names and the metrics they are filed under. |

`measure_names` and `metric_ids` are read from the DAX, so "who queried net sales" is one filter. An entry never holds a result row. The rows that a query returned count toward the caller's daily row budget ([Queries and results](/docs/use/for-agents-queries/)).

Agents should always send a `purpose`. It is one sentence on why the query runs, and it makes the log searchable by question.

An entry is written by a database role that can only insert. Nothing in the product edits or deletes one.

## Search it

```bash
pbmb queries search "net sales" --metric total_net_sales_excl_vat --status succeeded
pbmb queries show <query id>
```

The words match the DAX, the purpose and the dataset name. The filters are:

| Filter | CLI | Narrows to |
|---|---|---|
| `text` | the words | queries whose DAX, purpose or dataset name has them |
| `dataset` | `--dataset` | one dataset, by name or id |
| `workspace` | none (REST only) | one workspace, by name or id |
| `metric` | `--metric` | queries that used a measure of this metric |
| `mine` | `--mine` | your own queries |
| `principal` | none (REST only) | one caller's id |
| `status` | `--status` | `succeeded`, `truncated`, `failed`, `refused` |
| `since` | `--since` | queries at or after a time, as an ISO 8601 time such as `2026-10-01T00:00:00Z` |
| `until` | none (REST only) | queries before a time |

The table lists every filter. The MCP tool `search_query_log` takes `text`, `dataset`, `metric`, `mine`, `status` and `since`; `workspace`, `principal` and `until` exist on the REST route only, and the CLI has no `--workspace` or `--until`.

Results are newest first, 20 to a page and 100 at most, with a `next_cursor` for more. The MCP tools are `search_query_log` and `get_query`, and the REST routes are `GET /api/v1/queries` and `GET /api/v1/queries/{id}`.

A search shows the first 2,000 characters of the DAX and of the purpose, and says when it cut them. `pbmb queries show` and `get_query` give the whole text. To run a logged query again, take its DAX from `show`. A result that expired is gone, but its entry is not.

An agent that is about to write DAX for a metric should search the log with `--metric` first. DAX that worked before is the best starting point.

## Who sees what

What the log shows is decided by the policy `query_log:read`. The default policy lets every signed-in person and every service account read every entry: who ran it, when, which dataset, the DAX, the purpose and the row count. That is on purpose, so agents reuse DAX that worked.

Two things hold whatever a policy says:

- The `error` sentence is shown only to the entry's own caller. Power BI's error text can quote what the query read, so everyone else sees the status alone.
- A result is readable only by the caller who ran the query. Another caller who finds the entry sees the `result_id` and cannot read the rows.

The default rule does not look at the dataset. Someone can read an entry about a dataset they cannot describe. If the DAX or purposes on a dataset are sensitive, narrow the rule in a Cerbos policy. Compare both `principal_kind` and `principal_id` when you do, because a service account's name could equal a person's id. An entry the policy hides leaves no trace in a search: it takes no place on a page and never shows in `next_cursor`. [Roles and policies](/docs/make-it-yours/roles-and-policies/) shows how to add and test a policy.

Denied requests, created and revoked credentials, and admin actions are in the admin audit log (`pbmb admin audit`), not here. A query has one record, in this log.

## Check

```bash
pbmb dax run "Sales" --query 'EVALUATE ROW("Test", 1)' --purpose "Check the query log"
pbmb queries search "Check the query log" --mine --json
```

The search answers one entry. It has your id as `principal`, `status` `succeeded`, `row_count` 1 and your purpose. If the entry is missing, the query never reached the api, so check `pbmb whoami` for the address and the credential.
