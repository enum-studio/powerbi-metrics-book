---
title: Sign-in providers
description: What Microsoft, Google, OpenID Connect and passkeys each change about who can sign in and what they get, and how to turn one off.
sidebar:
  order: 5
---

The [Set up](/docs/set-up/) part has the steps to turn a provider on: where to register the app, the values to copy and the callback address. This page is about what each provider changes once it is on, and how to take one away. You need the admin role.

Signing in only proves who someone is. What they may do comes from roles ([Roles and policies](/docs/make-it-yours/roles-and-policies/)). A person who signs in and has no role is turned away with "Nobody has given you access to this Power BI Metrics Book yet. Ask one of its admins to add you."

## What each provider changes

| Provider | Who can use it | What the book learns | The role they start with |
|---|---|---|---|
| Microsoft | Accounts in your Power BI tenant only. Always on. | Their groups (Entra's `groups` claim) and a verified email. The Power BI connection needs it. | `access.default_role`, unless an assignment reaches them. |
| Google | Any Google account | A verified email. A Google Workspace account also vouches for its domain. | None by default. Only an assignment reaches them. |
| OpenID Connect | Whoever your identity provider lets in | A verified email, and groups from its `groups` claim. | None by default. Only an assignment reaches them. |
| Passkeys | People who already signed in with a provider in the last 7 days | Nothing new. A passkey is a shortcut back in. | The roles they already have. |

Some of this matters when you plan access:

- **Only Microsoft makes someone a member of your Power BI tenant.** The role `everyone in the tenant` and `access.default_role` reach Microsoft sign-ins only. A person signing in with Google or OpenID Connect needs an assignment: by email (`--person`), by domain (`--domain`, which counts only when the provider vouches for the domain) or by group (`--group` with `--provider <id>`).
- **Providers never merge accounts.** A person who signs in with Microsoft and later with Google has two accounts. A group assignment names its provider for that reason.
- **Passkeys are not a first way in.** A passkey works for 7 days after the person last signed in with their company account, and only when the device checks it is them with a PIN, a fingerprint or a face.
- **The Power BI connection is always a Microsoft account.** Queries run with the person's own connection. Whatever they sign in with, they connect a Microsoft account, and by default (`powerbi.connection_requires_matching_email`) its email must be the one they signed in with.

## Turn one on

The providers are the setting `sign_in.providers`, a list, and each has a client secret. Microsoft is configured in the app registration step and is never listed here. Google as an example:

```bash
pbmb admin settings set sign_in.providers \
  '[{"id":"google","kind":"google","label":"Google","client_id":"1234-sample.apps.googleusercontent.com","issuer":null}]'
pbmb admin secrets set sign_in_google_client_secret
pbmb admin check sign_in
```

Each entry has an `id` (lowercase letters, digits and underscores; it names the secret `sign_in_<id>_client_secret`), a `kind` of `google` or `oidc`, a `label` that the sign-in page shows, a `client_id`, and an `issuer`. An `oidc` provider needs an `issuer`, an https address. The ids `microsoft`, `dev`, `passkey` and `credential` are reserved, and `google` is reserved for the kind `google`.

`pbmb admin secrets set` prompts for the value and never takes it on the command line. A provider shows on the sign-in page once its secret is set.

The callback address you register with the provider is in the answer of `pbmb admin settings get sign_in.providers --json`, as `redirect_uris`: `<your address>/api/auth/callback/google` for Google, and `<your address>/api/auth/sso/callback` for OpenID Connect.

Passkeys are one switch:

```bash
pbmb admin settings set sign_in.passkeys true
```

## Turn one off

Take the entry out of the list, with the others kept. Read the list, then set it without the one you remove:

```bash
pbmb admin settings get sign_in.providers
pbmb admin settings set sign_in.providers '[]'
```

Passkeys:

```bash
pbmb admin settings set sign_in.passkeys false
```

A change shows on the sign-in page within 30 seconds. The provider's secret stays stored until you replace it, and it does nothing without its entry. Assignments that name the provider (`--group ... --provider google`) stay in place but match nobody until the provider is back.

Before you turn a provider off, list who relies on it with `pbmb admin people`. A person whose only sign-in was that provider cannot sign in again until they have another way in. Microsoft cannot be turned off.

## Check

```bash
pbmb admin check sign_in
curl -s "$PBMB_URL/api/auth/config"
```

The check prints passing or failing with the reason, and exits 1 on failure. The `curl` needs no credential. It answers what the sign-in page offers: `providers`, a list of `id`, `kind` and `name` that always starts with Microsoft, then `passkeys` as `true` or `false`, then `dev_sign_in`, then `sample_data`, which is `false` on any real deployment. A provider you turned off is gone from the list.
