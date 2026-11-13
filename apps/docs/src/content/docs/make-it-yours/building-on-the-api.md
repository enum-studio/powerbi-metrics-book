---
title: Building on the API
description: Make a service account and a key, take the OpenAPI file, generate a typed client, and run your own MCP server beside this one.
sidebar:
  order: 7
---

Everything the CLI and the web app do goes through one REST API at `/api/v1`. You can build on it the same way: a script that reacts to the change feed, a dashboard, an internal tool, your own agent tools. You need the admin role to make the first service account.

## A service account and a key

A service account is a named identity for a script, with its own keys. It holds roles and a grant: the workspaces and apps it may see. Without a grant it sees nothing.

```bash
pbmb sa create book-reader \
  --owner data-team@sample.example \
  --role viewer \
  --workspace <workspace id>
pbmb sa keys create book-reader --expires-in-days 30
```

`--owner` is the person answerable for it. `--role` can repeat. `--workspace` and `--app` take ids and can repeat. `--max-key-age-days` (1 to 90, default 90) caps how long any of its keys may live, and `--expires-in-days` sets one key's life within that cap.

The key prints once and cannot be shown again, because the API keeps only a digest. It starts with `pbmb_sk_`. Put it where the script reads it, such as `PBMB_API_KEY`. Never paste it into a chat or commit it. Rotate by making a new key and revoking the old: `pbmb sa keys list book-reader`, then `pbmb sa keys revoke book-reader <key id>`.

Send the key as a bearer token:

```bash
curl -s "$PBMB_URL/api/v1/me" -H "Authorization: Bearer $PBMB_API_KEY"
```

What a service account can and cannot do:

- It sees only the datasets in its grant, and a dataset outside it answers 404, as a missing one does. No policy can widen the grant ([Roles and policies](/docs/make-it-yours/roles-and-policies/)).
- It can hold `viewer` or `curator` to read or curate. It is refused every admin action, even with the `admin` role.
- It cannot approve a metric. Only a person does.
- It runs queries only if an admin turned on `powerbi.service_account_queries`, then as the app's own service principal, and never on a dataset with row-level security.
- It is limited to 60 requests a minute (`service_accounts.rate_per_minute`).
- `pbmb sa keys revoke` and `pbmb sa disable` stop a key or the whole account at once.

The REST API also takes `source_cidrs` on a service account, a list of address ranges its keys work from. It needs `TRUSTED_PROXY` set, because without it the API sees only the proxy's address. The API refuses it under `CLIENT_ADDRESS_HEADER=x-real-ip`, since a key limited by address must not rest on a header nobody verified.

## The OpenAPI file

The API's description is `apps/api/openapi.json` in the repository, OpenAPI 3.1. It is generated from the routes and checked in, so it always matches the code that serves them. Take the copy from the tag of the version you run. `pbmb admin status` shows the version. The [REST API reference](/docs/reference/rest-api/) is built from the same file and lists every route with who may call it and its shapes.

Errors answer `{ "error": kind, "message": ... }` with the status the kind maps to. Read the message: it is written to say what to change.

## A typed client

Any OpenAPI 3.1 generator works. The web app uses `openapi-typescript` and `openapi-fetch`:

```bash
npm install openapi-fetch
npm install --save-dev openapi-typescript
npx openapi-typescript ./openapi.json -o ./src/book-api.d.ts
```

```ts
import createClient from "openapi-fetch";
import type { paths } from "./book-api";

const book = createClient<paths>({
  baseUrl: process.env.PBMB_URL,
  headers: { Authorization: `Bearer ${process.env.PBMB_API_KEY}` },
});

const { data, error } = await book.GET("/api/v1/metrics/{name}", {
  params: { path: { name: "total_net_sales_excl_vat" } },
});
if (error) throw new Error(error.message);
console.log(data.trust_state, data.base_variants);
```

The types come from the file, so a field the API does not have is a compile error. Regenerate when you upgrade the stack.

## Your own MCP server beside this one

The connector at `/api/mcp` takes no plug-ins. Its tool list is fixed, and that fixed list is what the security tests cover. It also never changes the book. When you want tools of your own, run a second MCP server that calls `/api/v1` with a service account key, and give your agent both.

A small one in Python with the MCP SDK (`pip install mcp httpx`) that tells an agent which team owns a metric, using the custom field from [Custom fields](/docs/make-it-yours/custom-fields/):

```python
import os

import httpx
from mcp.server.fastmcp import FastMCP

server = FastMCP("book-extras")
api = httpx.Client(
    base_url=os.environ["PBMB_URL"],
    headers={"Authorization": f"Bearer {os.environ['PBMB_API_KEY']}"},
    timeout=30,
)


@server.tool()
def owner_team(metric: str) -> str:
    """The team that owns a metric in the book, by its key."""
    answer = api.get(f"/api/v1/metrics/{metric}")
    answer.raise_for_status()
    return answer.json()["custom"].get("owner_team", "nobody has said")


if __name__ == "__main__":
    server.run()
```

Your server holds the key, not the agent. Give it the smallest role and grant that does the job. The agent gets the connector's tools for reading, searching and querying under the person's own rights, and your tool for what is yours.

## Check

```bash
curl -s "$PBMB_URL/api/v1/me" -H "Authorization: Bearer $PBMB_API_KEY"
```

The answer has `"kind": "service_account"`, the account's name as `id`, and its `roles`. A wrong or revoked key answers 401 with a message. Then read one metric the account may see:

```bash
curl -s "$PBMB_URL/api/v1/metrics/total_net_sales_excl_vat" -H "Authorization: Bearer $PBMB_API_KEY"
```

The answer is the metric with its `trust_state`. A metric in a workspace outside the grant answers 404.
