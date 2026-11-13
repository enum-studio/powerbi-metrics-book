---
title: Sign-in
description: Your company chooses how people sign in. Microsoft, Google, any OpenID Connect provider and passkeys, each a client id and secret in the admin section.
sidebar:
  order: 20
---

You choose how people sign in. Microsoft is always on. You can add Google, any OpenID Connect provider (Okta, Auth0, Keycloak, a second Entra tenant) and passkeys. Each one is a client id and a secret, entered in the admin section or the CLI, and nothing is set in code.

Email and password sign-in is off by default and invite only. Passwords need at least 12 characters and are kept as Better Auth's scrypt digests. Invite links are stored as SHA-256 digests, work once for 7 days, and end when a new invite is sent. **Revoke** ends the invite. Reset links work once for 1 hour. Changing or resetting a password ends every session. Forgot password answers the same for an account and an unknown email, with the same timing. Only an emailed invite can set a password and verify the mailbox. An invite sent as a link the admin copies never sets a password. Resend delivers the links through the guarded fetcher; its key is encrypted for the api only.

Proved by [`apps/api/src/services/auth/email-password_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/email-password_security_test.ts).

## What each one needs

| Way to sign in | What you enter | Redirect address to register |
| --- | --- | --- |
| Microsoft | The tenant id, client id and secret of the app registration, in the setup. Single tenant: only your tenant's accounts sign in | `<PUBLIC_BASE_URL>/api/auth/callback/microsoft` and `<PUBLIC_BASE_URL>/api/v1/powerbi/callback` |
| Google | Your OAuth client id and secret | `<PUBLIC_BASE_URL>/api/auth/callback/google` |
| OpenID Connect | An id, a label, the client id, the issuer address and the client secret | `<PUBLIC_BASE_URL>/api/auth/sso/callback`, the same for every provider |
| Passkeys | One switch, `sign_in.passkeys` | none |

A provider's secret is stored like any other: write-only, encrypted for the api. [Secrets and tokens](/docs/security/secrets-and-tokens/) says how. The steps to set each one up, with every value to copy, are in [Set up](/docs/set-up/), under sign-in providers. The settings are in the [settings reference](/docs/reference/settings/).

## Add a provider

In the admin section, open Sign-in and add the provider. The same from the CLI, with Okta as the example:

```bash
pbmb admin settings set sign_in.providers '[{"id":"okta","kind":"oidc","label":"Okta","client_id":"0oa1b2c3d4","issuer":"https://example.okta.com"}]'
pbmb admin secrets set sign_in_okta_client_secret --expires 2027-06-30
pbmb admin check sign_in
```

For Google, use `"kind":"google"`, your client id, and `"issuer":null`. The id (`google` here) names the secret, `sign_in_google_client_secret`. The second command asks for the secret at a prompt with no echo. The last one prints:

```text
 status   passing
 message  -
```

Until the secret is set, the check fails with `Enter the client secret of the sign-in provider okta.` and the provider is not offered on the sign-in screen. For an OpenID Connect provider the check also fails when the issuer has no discovery document: `The provider okta has no discovery document at its issuer. Check the issuer URL: it ends before /.well-known.`

The check does not sign anyone in. After you add a provider, sign in once with its button, in a private window, before you rely on it.

## Who may sign in

Signing in proves who a person is. Whether they get in is decided at the callback, before an account exists: a person that no role assignment and no default role reaches is refused. See `access.default_role` and the roles in the admin section.

- Only the authorization code flow signs a person in. An ID token posted from a browser is refused.
- An email counts only when the provider says it is verified. A Microsoft email counts only when the token is your tenant's.
- An email domain assignment also needs a sign-in in the last 7 days that vouched for the domain: your Microsoft tenant, a verified OpenID Connect email, or a Google Workspace account of that domain. A personal Google account vouches for no domain.
- A group counts only at the provider that named it, so another provider cannot claim an Entra group's id.
- A second provider never joins the account another provider made for the same email.
- A session lasts 7 days from sign-in, with no sliding renewal.
- A passkey signs in only within 7 days of the person's last sign-in through a provider, and only when the device verified the person.
- Starting a sign-in is limited to 60 a minute per client address.

Proved by:

- [`apps/api/src/services/auth/sign-in-providers.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/sign-in-providers.test.ts): `refuses at the callback, before an account exists, a person no assignment reaches when the default role is none`, `signs in a person a group assignment at that provider reaches`, `never counts its token as membership of the Power BI tenant`
- [`apps/api/src/services/auth/sign_in_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/auth/sign_in_security_test.ts): `gives no person role to an email the provider does not call verified`, `gives no role for an Entra group to another provider's token that names its id`, `vouches for the email's domain only as a Workspace account of that domain`
- [`apps/api/src/services/settings/secret_destination_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/settings/secret_destination_security_test.ts): `is deleted when the provider is removed`

## Check it yourself

The sign-in screen shows one button for each provider that is ready. The api tells the screen which ones, and anyone can read the answer. It holds no client id, issuer or secret:

```bash
curl -s https://metrics.example.com/api/auth/config
```

```text
{"providers":[{"id":"microsoft","kind":"microsoft","name":"Microsoft"}],"passkeys":false,"dev_sign_in":false,"sample_data":false}
```

`sample_data` says whether the stack runs on the invented sample tenant. It is `false` on any real deployment.

After you add Okta and its secret, `providers` lists it as well, within 30 seconds. Switch passkeys on and the same answer shows `"passkeys":true`:

```bash
pbmb admin settings set sign_in.passkeys true
```

`dev_sign_in` must be `false` on a deployment people use. That route exists only when `NODE_ENV` is `development` or `test` and `ALLOW_DEV_SIGN_IN=1`, and the api refuses to start in production while any account it made is still in the database.

## Connecting Power BI is separate

Signing in with Microsoft also connects Power BI, so a person can query at once. A person who signs in another way connects a Microsoft account as a separate step. That account must have the same verified email address as the sign-in, and one Microsoft account connects to one person only. The setting `powerbi.connection_requires_matching_email` is on by default.
