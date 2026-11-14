---
title: Agents
description: Add the MCP address to Claude Code, Codex or Cursor, sign the command line in, and see the connector answer whoami.
sidebar:
  order: 4.2
---

**Connect your agent**, the last screen of the first run, gives these steps with your own address while the first sync runs, and sees it when your agent signs in. **Skip for now** passes it by: the same steps stay on **What to do next** and in your connections. Agents read the book through its connector (MCP) or the command line.

## Before you start

- You are signed in as admin: the check counts only an agent that signed in as an admin.
- Claude Code, Codex or Cursor on your machine.

## The values

**Connect your agent** shows these values with your own address:

```text
MCP address:       https://metrics.example.com/api/mcp
Install the CLI:   uv tool install powerbi-metrics-book
Sign the CLI in:   pbmb login --url https://metrics.example.com
```

## Steps

Add the connector to one agent. Each signs you in through your browser: press **Allow** on the consent screen, which names you, the client and where it sends you back.


**Claude Code**

1. Add the server, then open the MCP panel and sign in:

   ```bash
   claude mcp add --transport http powerbi_metrics_book https://metrics.example.com/api/mcp
   ```

2. In Claude Code run `/mcp`, choose `powerbi_metrics_book` and follow the sign-in.

**Codex**

1. Add this to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.powerbi_metrics_book]
   url = "https://metrics.example.com/api/mcp"
   ```

2. Sign in:

   ```bash
   codex mcp login powerbi_metrics_book
   ```

**Cursor**

1. Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

   ```json
   {
     "mcpServers": {
       "powerbi_metrics_book": {
         "url": "https://metrics.example.com/api/mcp"
       }
     }
   }
   ```

2. Open Cursor's **Customize** page, find `powerbi_metrics_book` and sign in when it asks.

Source: [Claude Code, Connect to tools with MCP](https://code.claude.com/docs/en/mcp), [Codex, Model Context Protocol](https://developers.openai.com/codex/mcp) and [Cursor, Model Context Protocol](https://cursor.com/docs/context/mcp).

Then, in the agent, ask: `Run whoami on the powerbi_metrics_book connector.` It answers with who you are acting for (your id and kind), your roles and whether your Power BI connection is ready.

**The command line** is for scripts and for agents that run shell commands:

```bash
uv tool install powerbi-metrics-book
pbmb login --url https://metrics.example.com
pbmb whoami
```

`pbmb login` prints a code and a page. Open the page, type the code and press **Allow**. Nothing opens by itself unless you add `--open`.

## Skills

The official agent skills teach your agent to use the book: `deploy_powerbi_metrics_book`, `adapt_conventions`, `curate_metrics_book`, `query_power_bi` and `answer_questions`. Install them on the machine your agent runs on. Each way below fetches them from the [GitHub repository](https://github.com/enum-studio/powerbi-metrics-book). They come from the `main` branch until a release is tagged, so read what changed before you take a newer version.

**Claude Code** installs them as a plugin, with a curator subagent:

```bash
claude plugin marketplace add enum-studio/powerbi-metrics-book
claude plugin install powerbi-metrics-book@powerbi-metrics-book
```

`claude plugin list` then shows `powerbi-metrics-book@powerbi-metrics-book` as enabled. They load the next time you start Claude Code, or at once after `/reload-plugins`. To take a newer version, run `claude plugin update powerbi-metrics-book@powerbi-metrics-book`.

**Codex and Cursor** read skills from `~/.agents/skills`, so copy them there:

```bash
git clone --depth 1 https://github.com/enum-studio/powerbi-metrics-book.git
mkdir -p ~/.agents/skills
cp -R powerbi-metrics-book/.agents/skills/. ~/.agents/skills/
```

`ls ~/.agents/skills` then lists the five folders, and you can delete the clone. To take a newer version, run the same commands in a new folder.

Source: [Claude Code, Install and manage plugins](https://code.claude.com/docs/en/discover-plugins), [Codex, Skills](https://learn.chatgpt.com/docs/build-skills) and [Cursor, Agent Skills](https://cursor.com/docs/context/skills).

If your own agent is doing this setup, `deploy_powerbi_metrics_book` walks it through the steps only a person can do, and checks each with `pbmb admin status`. `curate_metrics_book` and `query_power_bi` come into use after [First sync](/docs/set-up/first-sync/).

`whoami` also reports `questions`: off by default. An admin turns on **Questions** under **Settings, General**. The `answer_questions` skill applies only when questions are on. Requests and the usage report stay available either way.

An agent that queries needs people to have Build permission in Power BI. See [Running DAX for people](/docs/set-up/who-gets-in/#running-dax-for-people).

## Check

The check passes when a person with the admin role has called `whoami` through the connector. **Connect your agent** sees it as it happens. To run it from a terminal:

```bash
pbmb admin check agents
```

If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#agents).

After the [first sync](/docs/set-up/first-sync/), ask your agent to structure drafts, or review the [security checklist](/docs/set-up/security/).
