---
title: Reference
description: Configuration, the CLI, the MCP tools, the REST API and upgrading, generated from the code where it can be.
sidebar:
  order: 0
  label: Overview
---

This part lists every command, tool, route and setting. It is for the person who knows what they want and needs the exact name, and for agents looking up an argument. The CLI, MCP tools, REST API and settings pages are generated from the code, so they cannot drift from it.

Pages:

- [CLI](/docs/reference/cli/): every `pbmb` command, with its arguments and options.
- [MCP tools](/docs/reference/mcp-tools/): every tool the connector offers, with its input.
- [REST API](/docs/reference/rest-api/): every route, grouped, with who may call it and its shapes.
- [Settings](/docs/reference/settings/): every setting and secret, its default and its environment variable.
- Upgrading: how to move a deployment to a new release.
- [Changelog](/docs/reference/changelog/): what each release changes, copied from `CHANGELOG.md` at build.

To change one of the generated pages, change the help text, description or default in the code, then run `pnpm --filter @powerbi-metrics-book/docs gen:reference`.
