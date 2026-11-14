---
title: "For agents: questions and feedback"
description: Ask a question or leave a comment on any element, follow the answer, and let accepted answers reach the next person.
sidebar:
  order: 4
---

Questions are off by default. An admin turns on **Questions** under **Settings, General**, or runs:

```bash
pbmb admin settings set questions.enabled true
pbmb whoami --json
```

Check that `questions` is `true` before following this page. Turning questions off hides their tools, routes and catalog fields, and keeps stored threads. Requests and the usage report stay available.

When a definition is missing, wrong or unclear, ask. Do not guess and do not edit the book. A question goes to the people who curate the element, and an accepted answer shows up in the element's own answers, so the next agent finds it without asking.

Anyone signed in can ask or comment on a workspace, dataset, table, column, measure, metric, variant, term, category or logged query that they may see.

## Look before you ask

`get_metric` and the other `get_*` answers carry the count of open questions on the element and its accepted answers. Read them first. If the question is already open, upvote it instead of posting it again:

```bash
pbmb questions list --element metric:<metric id> --status open
pbmb questions upvote <thread id>
```

You have one upvote for each question. `--remove` takes it back. The MCP tool is `set_upvote`.

## Ask a question

```bash
pbmb questions ask metric <metric id> \
  --title "Is total net sales before or after returns?" \
  --body "The definition says order lines, before returns. Sales shows Net sales and Finance shows Revenue for the same month. Which one goes in the board pack?"
```

The kind is one of `workspace`, `dataset`, `table`, `column`, `measure`, `metric`, `variant`, `term`, `category` or `query`. The element is its id. The MCP tool `post_thread` takes the same: `kind` (`question`), `element` (`{ "kind": "metric", "id": ... }`), `title` and `body`.

A good question says what you tried, what you expected and what you saw. The title is one line, at most 300 characters. The body is plain text with Markdown, at most 20,000 characters, and is shown as text, never as HTML.

A question has a title and can be answered and upvoted. A comment has no title, takes replies, and is for a note that needs no answer:

```bash
pbmb questions comment column <column id> --body "Holds the ship date, not the order date."
```

## Follow it

```bash
pbmb questions list --mine
pbmb questions show <thread id>
```

`list --mine` shows your questions. With `--json`, each carries its reply count and the replies you have not read. Reading a thread with `show` (`get_thread` in MCP) marks its replies read. Filter by `--status` (`open`, `answered`, `archived`) or `--element kind:id`. Archived threads are left out unless you ask for them.

Add to a thread with `pbmb questions reply <thread id> --body "..."` (`reply_in_thread`).

## Accept the answer

When a reply settles it, accept it:

```bash
pbmb questions accept <thread id> <reply id>
```

Only the person who asked or a curator can accept, and only a question takes an accepted answer. The thread becomes `answered`, and the accepted reply is returned with the element from then on. It says who accepted it: `accepted_by_role` is `asker`, `asker_own_reply` (the asker accepted their own reply), `curator`, or `unknown` for an answer accepted before this was kept. `accepted_by_kind` is `service_account` when an agent accepted it. A reader should weigh an asker's own acceptance as the asker's word, not a curator's. A curator can archive a thread with `pbmb questions archive <thread id>`. It leaves the default lists and search but is kept. An archived thread takes no more replies.

## What a person sees

Everyone who can see the element can read its threads. A thread on a dataset someone may not describe answers like a missing one. The curating team sees new questions in the change feed as `thread.created`, and answers as `thread.replied`, `thread.answered` and `thread.archived` ([The change feed](/docs/make-it-yours/change-feed/)).

## Check

```bash
pbmb questions list --mine --json
```

After you ask a question, the list holds it with `status` `open`, your id as its author and no replies. After someone accepts a reply, the same call shows `answered`, and `pbmb metrics show <name>` lists the answer under the metric's accepted answers.
