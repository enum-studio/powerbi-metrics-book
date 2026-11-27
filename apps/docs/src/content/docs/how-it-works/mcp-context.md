---
title: How much context does a CSV download save?
description: See what an assistant reads when it searches for a metric, opens one definition and downloads thousands of rows from Power BI Metrics Book.
sidebar:
  order: 2
  label: Context savings
---

**A 2,938-row sales export took 70,783 tokens with every row included in the reply. With a CSV link and no preview, the reply took 294 tokens.** The downloaded file still contains all 2,938 rows. The saving comes from sending the rows straight to a file.

Metric discovery works on the same principle. A short list lets the assistant choose which definition deserves a closer look. Both examples below use invented data from the sample book.

## Find the right metric without opening every definition

> Which channel brought in the most turnover in September 2026?

You can start with the words in the question. There is no need to know the dataset name or how the company spells the measure in DAX.

| Follow the question | What the sample book tells you |
| --- | --- |
| **Search for `turnover`** | The curators recorded Turnover as an alias of **Net sales**. A search hit gives the assistant a name, a short summary and the metric ID to open. |
| **Open Net sales with `get_metric`** | Its definition specifies euros after discounts and before returns. The usage notes recommend it for channel splits and distinguish it from Finance's Revenue measure. |
| **Look up `Channel` in the glossary** | Here it means where the order was placed. The term links to the Channel column in Sales. A marketing channel answers a different question about where a visitor came from. |

Those entries identify the **Sales** dataset, the **Net sales** measure, the **Channel** grouping and the order date. In the September sample rows, **Store leads with EUR 5,354.27**. If the person meant which adverts brought customers in, that needs a different analysis. The glossary makes that distinction visible before the assistant runs the query. [How search finds a match](/docs/use/for-agents-search/)

### What does opening just one metric save?

If you want to browse, `list_metrics` shows a summary of up to 240 characters per metric. It includes enough to choose, such as the label, aliases and unit. `get_metric` opens the selected entry with its definition, usage notes, caveats and measure references.

We took the same four documented sales metrics and compared three ways to read them. The measurements start at the list call. The search and glossary lookups above explain how to choose a metric and are outside these counts.

<figure class="reply-sizes">
  <figcaption>Tokens returned for four sample metrics</figcaption>
  <div><span>All four full definitions</span><strong>1,360</strong><i aria-hidden="true" style="--share: 100%"></i></div>
  <div><span>List, then open Net sales</span><strong>699</strong><i aria-hidden="true" style="--share: 51.4%"></i></div>
  <div><span>List only</span><strong>315</strong><i aria-hidden="true" style="--share: 23.2%"></i></div>
</figure>

The short list cost **315 tokens**. Opening Net sales added **384**. Together they saved **661 tokens (49%)**. If the list alone answers the question, it saves **1,045 tokens (77%)**. An assistant that opens every entry pays for the list as well as the details.

## Download thousands of rows with a small reply

Suppose you want the order lines behind a sales report for a spreadsheet. In this example every row includes order ID, line number, order date, quantity and net amount. Each row you include in chat takes up context. Saving the CSV directly to disk keeps its contents available for analysis outside the conversation.

| Rows in the result | Every row in the reply | Default preview and CSV link | CSV link, no preview |
| ---: | ---: | ---: | ---: |
| 100 | 2,692 tokens | 774 tokens | 293 tokens |
| 1,000 | 24,289 tokens | 775 tokens | 294 tokens |
| 2,938 | 70,783 tokens | 775 tokens | **294 tokens** |

For 2,938 rows, the default **20-row preview** saved **70,008 tokens (98.9%)**. Skipping the preview saved **70,489 tokens (99.6%)**. Both replies include the column names, row count, result ID and download link.

**To inspect the result**, run `execute_dax` with its default preview. If you need a few more rows, pass the returned `next_offset` to `read_query_result`.

**To export the result**, set `preview_rows` to `0` in `execute_dax`. Download the returned `csv_url` directly to a file. With the CLI, save an existing result by its ID:

```sh
pbmb results csv "$result_id" -o sales.csv
```

Pasting the downloaded 2,938-row **five-column** CSV back into chat would itself use **70,501 tokens**. To keep the saving, read the file in a spreadsheet or calculate the answer locally and return just the totals. The file contains every row Power BI returned. If Power BI limited the underlying result, the query reply flags it with `truncated`. [Query previews, paging and downloads](/docs/use/for-agents-queries/)

<details>
<summary>How to reproduce the numbers</summary>

These are offline measurements of tool-reply text, using the sample sales rows, the sample metric documentation and the Metrics Book MCP formatters. The four metric records have fixed IDs and one base measure each. Both list sizes use the same records and page envelope. The larger version substitutes full metric details for each summary.

For query results, the benchmark holds the columns, rows and result metadata fixed, including a sample download URL. It changes how many rows the preview contains. The full-row column models an unlimited reply. The connector normally caps replies at 16 KiB. Token counts use tiktoken's `o200k_base` encoding and exclude tool definitions, requests, transport headers and file transfers. Row width, text length and the model's tokenizer affect the counts.

Run this from the repository root after installing dependencies.

```sh
pnpm --filter @powerbi-metrics-book/api exec tsx ../../apps/docs/scripts/context-payloads.mjs |
  uv run --script apps/docs/scripts/measure_context.py
```

</details>
