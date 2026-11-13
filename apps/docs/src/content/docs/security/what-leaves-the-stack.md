---
title: What leaves the stack
description: Every outbound host, the container that calls it, what each call carries, and how to see that nothing else leaves.
sidebar:
  order: 45
---

Two containers make requests to the internet, the `api` and the `worker`. Postgres and Cerbos are on an internal network with no route out. The stack sends no telemetry. This page lists every host the two containers call, what each call carries, and how to check the list on your own deployment.

## The hosts

The addresses below are the defaults. The four settings named in the table (`powerbi.authority`, `powerbi.api_url`, `powerbi.graph_url` and `search.base_url`) are set only in the environment of the container, never in the admin section, because they say where a secret is sent.

| From | To | Carries | Why |
| --- | --- | --- | --- |
| api | `login.microsoftonline.com` (`powerbi.authority`) | the sign-in code, the app registration's client id and secret, a person's Power BI refresh token | Microsoft sign-in, connecting Power BI, and refreshing it |
| api | `api.powerbi.com` (`powerbi.api_url`) | the DAX of a person's query, under their own access token | running queries as the person |
| api | `graph.microsoft.com` (`powerbi.graph_url`) | a person's access token, to read their Entra groups | who is in which group |
| api | the embedding provider: `api.openai.com` or `generativelanguage.googleapis.com`, or `search.base_url` | the text of a search query, and your key in a header | search by meaning. Metadata only, see below |
| api | Google (`oauth2.googleapis.com`, `www.googleapis.com`), only if you add Google sign-in | the sign-in code, your Google client id and secret | Google sign-in |
| api | the issuer of each OpenID Connect provider an admin adds | discovery, then the sign-in code, your client id and secret | that provider's sign-in |
| api | the address of an MCP client's metadata document | a plain GET, nothing from the stack | an agent's client registers itself with a URL |
| worker | `login.microsoftonline.com` | the scanner registration's client id and secret | a token for the scanner |
| worker | `api.powerbi.com` | requests for workspace lists and scans | the Admin Scanner API: metadata and DAX, never rows |
| worker | the embedding provider | the book's names, descriptions, display folders and term values | embedding documents for search |

Your browser also goes to Microsoft, Google or your provider when you sign in. Those are your browser's requests, not the stack's.

## What the embedding provider sees

The provider sees the names, descriptions, display folders and term values of the book, and the text of each search. It never sees DAX, a query result or a thread's text. A variant in a personal workspace leaves out the workspace's name, which is its owner's.

An agent can type anything into a search, including a value it read from a result, so treat a search query as data that reaches the provider. Set `search.provider` to `none` and nothing is sent: search then works on words alone.

```bash
pbmb admin settings get search.provider
```

```text
 key                   search.provider
 value                 none
 source                default
```

`none` is the default. The key goes only in a request header, to the host above, which the fetcher checks against its list. It does not appear in an error, a log or the usage table.

## Nothing is sent to an address a person typed in

One kind of address is typed in by a person: the issuer of an OpenID Connect provider, which an admin adds. The api reaches it through the strict profile of the guarded fetcher: `https`, a public address after DNS resolution, 5 seconds, 64 KiB and no redirects. Your client secret goes to that issuer's own origin when someone signs in, because that is how OpenID Connect works. Moving a provider to another issuer or kind, or removing it, deletes its secret in the same transaction, so a changed address never receives the old secret.

An MCP client's metadata document is also fetched from a URL the client names, through the same strict profile. The request carries nothing from the stack.

Every other address is fixed: it comes from the container's environment, which the operator controls, and the fetcher refuses any other host. Better Auth makes its own sign-in requests to Microsoft, Google and the OpenID Connect issuer, outside the guarded fetcher. [The threat model](/docs/security/threat-model/) names what limits that.

Proved by:

- [`apps/api/src/http/fetcher_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/http/fetcher_security_test.ts): `refuses a host that resolves to the cloud metadata address before connecting`, `refuses a host when any one of its addresses is internal`, `refuses a %i, even to another configured host`
- [`apps/api/src/services/settings/secret_destination_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/settings/secret_destination_security_test.ts): `are exactly the environment-only ones`, `is deleted, with its ciphertext, when the provider moves to another issuer`
- [`apps/api/src/services/auth/oidc_issuer_trust_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/oidc_issuer_trust_security_test.ts): `refuse the provider when sign-in would call another origin`
- [`apps/api/src/services/auth/authority_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/authority_security_test.ts): `must be https in production, and the error names the setting`

## Check it yourself

See where the four fixed hosts point and where each value comes from:

```bash
pbmb admin settings get powerbi.authority
```

```text
 key                   powerbi.authority
 value                 https://login.microsoftonline.com
 source                default
 environment_only      true
```

Run the same for `powerbi.api_url`, `powerbi.graph_url` and `search.base_url`. A value with `source environment` was set by your operator. Nothing an admin types in the admin section changes them.

Check which containers can reach the internet. Only `api` and `worker` are on `egress`, and `app` is internal (the project name is your deployment folder's, unless you set `-p`):

```bash
docker network inspect pbmb_app pbmb_egress --format '{{.Name}} internal={{.Internal}}'
```

```text
pbmb_app internal=true
pbmb_egress internal=false
```

Confirm that no code calls `fetch` outside the guarded fetcher, from a checkout:

```bash
grep -rnE "(^|[^.A-Za-z_])fetch\(" apps/api/src | grep -vE "test\.ts|_test\.ts"
```

```text
apps/api/src/http/fetcher.ts:193:    const response = await fetch(target, {
```

The repository's semgrep rule `.semgrep/rules/no_fetch_outside_guarded_fetcher.yml` refuses a `fetch` anywhere else.

Confirm that telemetry is off in the two components that have a setting for it:

```bash
grep -n -A1 telemetry stack/cerbos/config.yaml
grep -n telemetry apps/api/src/services/auth/better-auth.ts
```

```text
26:telemetry:
27-  disabled: true
324:    telemetry: { enabled: false },
```

To be sure of the whole list on your network, block everything from the `egress` network except the hosts above and watch your firewall's log. A request to any other host is a bug: report it as described in [Reporting a vulnerability](/docs/security/reporting/).
