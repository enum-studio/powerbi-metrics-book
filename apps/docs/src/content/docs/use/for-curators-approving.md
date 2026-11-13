---
title: "For curators: approving"
description: Ask a person to review a metric, what the review page shows, and what Approve changes.
sidebar:
  order: 6
---

An agent can structure a metric and verify it. Only a person can approve it. Approval is the line between "an agent checked the rules" and "someone who knows the business says this number is right". This page covers both sides: the agent asking for a review, and the curator giving it.

## Ask for a review

When a metric is `agent_verified`, the agent asks a person to look at it:

```bash
pbmb metrics request-review total_net_sales_excl_vat
```

The command prints the link to the metric's catalog page, `<your address>/catalog/metrics/total_net_sales_excl_vat`, and the metric's trust state. Older `/review/metrics/` links redirect there. Hand the link to a curator. Do not try to approve the metric yourself: an agent holding a person's CLI or MCP token is refused, and a service account never can be.

## Review it

Open the link in a browser, signed in as a curator or an admin. The page shows the metric's description, its variants with their DAX, the checks that fail, its history and its open questions. Read the definition as a business reader would. Then check the parts an agent cannot judge:

- Does the definition say what people mean by the name?
- Is the base variant in each dataset the right measure? Compare the DAX.
- Are the shifted variants really the same calculation shifted, or a different one?
- Is any open question on the metric still waiting for an answer?

If something is wrong, do not approve. Ask the agent to fix it, or answer the open question first. A change made through a browser session keeps the state. A change an agent makes with a token moves it (below).

## Approve

The Approve button sets the state to `human_verified`, and records who and when. It is refused while a check fails, the same as verifying. The REST route behind it is `POST /api/v1/metrics/{name}/approve`.

Under the default conventions, `human_verified` is set only from a browser session. Setting `trust.human_verify_from` to `any` lets a person approve with the CLI or an MCP token too. That is a deliberate step: it lets an agent that holds a person's token approve its own work. The API accepts a change to any `trust.*` rule only from a person's browser session, so `pbmb conventions set` and `pbmb conventions import` cannot make it. A service account can never approve, whatever the setting.

Who may approve is a policy decision on `book:approve`. By default curators and admins can. A company that wants only admins to approve narrows it in a Cerbos policy ([Roles and policies](/docs/make-it-yours/roles-and-policies/)).

## What approval means afterwards

| What happens | The state becomes |
|---|---|
| A person approves | `human_verified` |
| An agent changes the metric with a token, and every check still passes | `agent_verified` |
| An agent changes it with a token, and a check fails | `draft` |
| Someone changes it through a browser session (the web app's API session) | stays `human_verified` |

So `human_verified` means a person approved the metric and nothing has changed it through a token since. Anyone can see the trust state, who set it and when, in `get_metric` and in search. The metric's history keeps the before and after of every change.

When a metric drops from `human_verified`, ask for a review again. The `metric.approved` event in the [change feed](/docs/make-it-yours/change-feed/) tells you when someone approves.

## Check

```bash
pbmb metrics show total_net_sales_excl_vat --json
```

Before the review, `trust_state` is `agent_verified`. After a curator approves, it is `human_verified`, with `verified_by` set to the curator and `verified_at` to the time. `pbmb metrics history total_net_sales_excl_vat` lists the approval with `via` set to `browser`.
