---
title: What Power BI Metrics Book is
description: A small stack you run yourself that gives your agents the right numbers from your Power BI, and who it is for.
slug: index
sidebar:
  order: 1
  label: What it is
---

Power BI Metrics Book gives your agents the right numbers from your Power BI. You run it yourself as four containers, point it at your Power BI tenant, and your agents ask it instead of guessing at measures.

It does five things.

- **It mirrors Power BI.** Workspaces, semantic models (this site says dataset, as Power BI's REST API does), tables, columns, measures and relationships, synced on a schedule.
- **It keeps a metrics book.** A metric is a business concept with one calculation. A variant is that calculation shifted only on currency, period or comparison. A different calculation is a different metric, never a variant.
- **It starts the book for you.** The sync turns every measure into a draft metric. Your own agent then names them, describes them and files them, and a person approves.
- **It lets agents query.** DAX runs against a dataset under the asking person's own Power BI rights, so row-level security holds. A big result stays on the server and is read page by page or taken as a CSV file.
- **It lets agents find things.** Semantic search over metrics, variants, columns and terms, plus filters for when ranking misses.

Agents reach it three ways, all through the same rules: an MCP connector (the main one), the `pbmb` command line, and a REST API with service-account keys.

## Who it is for

- **A company that already runs Power BI** and wants its agents to answer with the company's own definitions.
- **The person who sets it up.** Usually a Power BI admin or an engineer next to one. You need rights to register apps in Microsoft Entra and to change Power BI tenant settings. If you have never registered an app in Entra, the Set up part walks you through every click.
- **The agents that connect**, such as Claude, Codex and Cursor. Pages are written so an agent can follow them step by step: every command and value to copy, and the check that proves the step worked.

## Read the Start part in this order

1. [The stack](/docs/start/the-stack/): what runs, and who talks to whom.
2. [Quickstart](/docs/start/quickstart/): three commands, then the setup link.
3. [Try it on the sample tenant](/docs/start/sample-tenant/): no tenant to connect yet? Run the stack on invented data first, and move to your own tenant when you can.

Then follow the [Set up](/docs/set-up/) part, one page per setup step.
