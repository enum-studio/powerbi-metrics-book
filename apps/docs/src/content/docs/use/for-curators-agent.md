---
title: "For curators: start with an agent"
description: One sentence starts your agent on the whole book. It digs, writes and checks. You answer the business questions at four check-ins.
sidebar:
  order: 4.5
---

Tell your agent to run `pbmb curate`, and it curates the book in batches. It does the digging and the writing. You answer what only the business knows, at four set points. You need the curator role and a finished sync.

## What to run

Sign in yourself, in your own terminal:

```bash
uv tool install powerbi-metrics-book
pbmb login --url https://metrics.example.com
```

Open Claude Code, Codex or Cursor in any folder and tell it:

```text
Run `pbmb curate` and follow what it prints.
```

`pbmb curate` changes nothing. It checks your login and your role, counts the metrics in each trust state, and prints the brief the agent follows. The brief is the `curate_metrics_book` skill, so the agent needs nothing else installed.

If you are signed out or your role is too low, the command says so and the agent asks you to fix it. Never paste a token or a key into the chat.

## What the agent does

- It reads your [conventions](/docs/make-it-yours/conventions/) first, and they win over its brief on naming, describing and grouping, and on nothing else.
- It reads the DAX, tables and relationships, and runs queries under your own Power BI rights to see real values. Each query states its purpose and is in the [query log](/docs/use/query-log/).
- It searches the web for public terms and public company facts, when it has that tool. It searches only a word it can tell is public, and never sends DAX, query results or internal names.
- It proposes a structure for the whole book: categories, families, which drafts are one calculation, which are not metrics.
- Once you agree the plan, it writes descriptions, sets the shifts it can prove, files metrics, links terms, and marks each metric that passes the checks as `agent_verified`.
- It keeps `curation_progress.md` in its folder. Say the same sentence in a new session and it carries on. The file holds internal names, so it keeps it out of any repository. A new session treats it as notes and asks you to reconfirm each recorded yes.

## What it asks you, and when

| Check-in | What it asks | What you do |
|---|---|---|
| Start | What matters most, where definitions already live, who owns what | Answer once, and point it at any catalog, wiki or documents |
| After the first pass | The category tree, and one list of merges, renames, dismissals and deletes | Strike the lines you do not want, then answer |
| During | A short list of business questions: what a word means here, which of two numbers is right, what a threshold should be | Answer what you can |
| End of a batch | What it did, what waits for approval, the links, and how many to spot-check | Open the links and approve in your browser |

Your answer applies to the list as you left it, and to nothing else. Those lines need your yes because they are hard to undo: a merge deletes a metric, and a rename stops the old key working. The rest of the agreed work goes on without more questions.

No answer is never a yes. An agent that cannot ask, such as a subagent, returns the plan and stops.

## How long to expect

These are rough figures, not measurements. Your part is about 10 minutes at the start, 30 minutes on the list, and a few minutes on each list of questions. On a book of thousands of drafts, the agent's first pass can take a few hours, and the work spans several sessions.

## What it cannot do

- It cannot set `human_verified`. Only a person in a browser can ([approving](/docs/use/for-curators-approving/)).
- It does not merge, rename, delete, dismiss or create a category without your line on the list.
- It does not change the conventions, settings, roles or secrets.
- It sees only what your own Power BI rights let you see.
- It does not run on a service account: `pbmb curate` refuses one, and the skill starts with `pbmb whoami` and stops on one, so every change has a person behind it.

Each step, with examples, is in [structuring drafts](/docs/use/for-curators-drafts/). `pbmb metrics history <name>` shows every change to a metric.

## Check

```bash
pbmb curate
pbmb metrics list --trust-state agent_verified
```

`pbmb curate` prints your login, the counts and the brief. After a batch, the second command lists the metrics waiting for a person's approval.
