---
title: How it works
description: How the Power BI mirror, metrics book and query tools fit together, with the stack architecture and measured context savings.
sidebar:
  order: 0
  label: Overview
---

Power BI Metrics Book keeps business definitions beside your Power BI models. It mirrors the models' metadata, adds a curated book of metrics and terms, and gives people and agents a way to find a measure and query it under their own Power BI rights.

## From a model to an answer

1. **Mirror the metadata.** The worker reads workspaces, datasets, tables, columns, measures and relationships from Power BI. The mirror keeps Power BI's names and descriptions.
2. **Build the book.** The worker groups measures into drafts where it can establish that they calculate the same thing. Curators add definitions, aliases, usage notes and terms, and review the result. Later syncs preserve a curator's filing.
3. **Find the measure.** Search returns short summaries. An agent opens the selected metric to read its definition, measure references and caveats before writing a query.
4. **Run the query.** The API checks access through Cerbos and calls Power BI with the asking person's delegated token. Power BI applies that person's permissions and row-level security.
5. **Read or download the result.** A small preview helps inspect the answer. A CSV download carries the rows to a file without putting every row into the conversation.

The browser, CLI, REST API and MCP connector use the same service layer for access decisions and book operations. The [concepts guide](/docs/use/concepts/) defines the mirror, metrics, variants and trust states in more detail.

## System design

- [The stack](/docs/how-it-works/the-stack/): the four containers, their responsibilities, and the networks and services they communicate over.
- [Context savings](/docs/how-it-works/mcp-context/): why search returns summaries and queries return previews, with reproducible token counts for the sample book.
- [Security](/docs/security/): access checks, credential storage and what leaves the stack, with a threat model and verification checklist.

To follow the flow yourself, [try the sample tenant](/docs/start/sample-tenant/), then use the guides for [searching](/docs/use/for-agents-search/) and [queries and results](/docs/use/for-agents-queries/).
