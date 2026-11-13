---
title: What is not a setting
description: The rules that make the product safe to run, why each stays in the core, and what to do if you need one changed.
sidebar:
  order: 8
---

Almost everything in this part is a place to change a default. These are the exceptions. Each rule below is code, not a setting, because it is what makes the stack safe to run. If it were a switch, one wrong click, or one agent holding an admin's token, could turn the protection off.

Each rule has a security test that fails the build if it stops holding. The name of the test is beside it. To change a rule, send a pull request to the core. That puts the change in front of a reviewer and under the test.

## The rules

| Rule | Why it stays in the core | Its test |
|---|---|---|
| Only a short list of paths answers without a credential. | A setting here could open a route to the internet. The list is in code and a test names every entry. | `public-paths_security_test.ts` |
| Every route checks its own credential, and every route and tool is asked for in every role. | A route added later cannot skip the check. A matrix test calls each one as each kind of caller, allowed and refused. | `authorization_matrix_security_test.ts` |
| A result can be read only by the person or service account that ran the query. | A result holds data under that person's row-level security. A policy that widened it would copy data past Power BI's own rules. | `result_ownership_security_test.ts` |
| The connector never changes the book. | A connected agent reads, searches, queries and asks. Changes go through the curation API, which needs a role and is audited. The connector takes no plug-ins, so its tool list is the one the tests cover. | `connector_surface_security_test.ts` |
| Secrets and tokens are encrypted for the container that reads them, and a secret cannot be read back. | The API container and the worker each hold their own key. An admin can set a secret and replace it, and nobody can show it. | `secret_at_rest_security_test.ts`, `secret_write_only_security_test.ts` |
| A service account is held to the workspaces and apps it was given. | A Cerbos policy cannot see the grant of a caller that a policy does not name. The API checks it in code after the policy, so no policy can widen it. | `service_account_bound_security_test.ts` |
| A service account never performs an admin action, except reading the status. | A leaked key must not become an admin. | `service_account_bound_security_test.ts` |
| Only a person approves a metric, and by default only from a browser session. | A policy cannot see how a request arrived. An agent with a person's token must not approve its own work. | `approval_browser_only_security_test.ts` |
| A change to the `trust.*` conventions comes only from a person's browser session. | A token that could rewrite those rules could allow its own approvals. | `approval_browser_only_security_test.ts` |
| The addresses the stack sends secrets to are set only in the environment: `powerbi.authority`, `powerbi.api_url`, `powerbi.graph_url` and `search.base_url`. | An admin session that could set them could send a client secret to a host of an attacker's choosing. | `secret_destination_security_test.ts` |
| Outbound calls go only to the configured hosts. A URL someone else chose (an OpenID Connect issuer) is fetched over https to public addresses only, with a short timeout, a size limit and no redirects. The stack sends nothing to an address a person typed in. | A server that fetches whatever it is told is a way into your network. It is also why the change feed is a pull and not a webhook. | `fetcher_security_test.ts` |
| The audit log is written by a database role that can only insert. | A record that an admin could edit is not a record. | `audit_append_only_security_test.ts` |

Rules that look like settings but are not:

- **Who may see a dataset** is a setting (`access.metadata_visibility`), and who may do what is a policy. Both can narrow or widen what people see inside the limits above. They cannot reach past a service account's grant or past a result's owner.
- **`trust.human_verify_from`** is a setting, but only a person's browser session can change it.

## What you can do instead

Most wishes behind a request to change a rule have a place that is a setting:

| You want | Use |
|---|---|
| Fewer people to approve | A Cerbos policy on `book:approve` ([Roles and policies](/docs/make-it-yours/roles-and-policies/)). |
| An integration to read the book | A service account with a grant ([Building on the API](/docs/make-it-yours/building-on-the-api/)). |
| Your tool to react to changes | The [change feed](/docs/make-it-yours/change-feed/), polled by a service account. |
| Agents with more tools | Your own MCP server beside the connector. |
| An approval from the CLI for a small team | `trust.human_verify_from: any`, set by a person in a browser. Weigh the risk first. |
| One dataset not queryable | A custom field on the dataset and the default policy ([Custom fields](/docs/make-it-yours/custom-fields/)). |

The [Security](/docs/security/) part has the evaluator's view of the same rules.

## Check

```bash
pnpm --filter @powerbi-metrics-book/api exec vitest run _security_test
```

Run it from a checkout of the repository, with Docker running, because the tests use a real Postgres and Cerbos. It runs every security test, the ones named above and the others, and every one must pass. Against a running stack, the nearest check is that a route without a credential is refused:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$PBMB_URL/api/v1/me"
```

It prints `401`.
