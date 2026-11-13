---
title: Sign-in
description: Sign in with Microsoft on screen 3, then manage additional sign-in providers in the admin section.
sidebar:
  order: 3.5
---

Additional sign-in providers are set in the admin section, not during the first run. Screen 3, **Sign in**, uses Microsoft through the sign-in app you just checked.

## Screen 3: Sign in

1. Finish all five items on **Connect your Microsoft tenant**. Before continuing, check both **Web** redirect URIs under the sign-in app's **Authentication (Preview)**, on the **Redirect URI configuration** tab. Select **Add Redirect URI** to add either missing URI:

   ```text
   https://metrics.example.com/api/auth/callback/microsoft
   https://metrics.example.com/api/v1/powerbi/callback
   ```

   Use your own host. `AADSTS500113` means the app has no reply address. `AADSTS50011` means the redirect URI does not match. Add the exact URIs before trying again.
2. Select **Sign in with Microsoft** and use the account that will administer the book. Confirm **Make me the admin** when asked. You become the first admin and the setup link ends.
3. The page goes straight on to connect your Power BI. With admin consent already granted, Microsoft sends you back without asking again. The app registration check now checks your own token's delegated permissions.

### Check screen 3

You are signed in as admin, your Power BI is connected, and screen 4, [What to sync](/docs/set-up/what-to-sync/), opens. If Microsoft refuses a redirect, check **Authentication (Preview)** above. For a check's sentence, see [When a check fails](/docs/set-up/when-a-check-fails/#the-app-registration).

## Sign-in providers in the admin section

After setup, open **Settings**, **Authentication** to add Google, another OpenID Connect provider or passkeys. Microsoft sign-in is always on.

For what each way of signing in changes about who gets in, read [Sign-in providers](/docs/make-it-yours/sign-in-providers/).

## Before you start

- [The app registration](/docs/set-up/app-registration/) has passed. Its two redirect URIs already cover Microsoft.
- For each provider you add, an account in its console that can create an application.

## Steps

In the admin section, under **Authentication**, the **Providers** list shows **Microsoft** (always on) and two buttons, **Add Google** and **Add an OpenID Connect provider**. Each provider you add shows a **Redirect URI** to copy and takes a **Client id**. Its secret goes under **Credentials**, in **Client secret of** the provider's id, with **The secret expires on**.

### Add Google

1. In the admin section press **Add Google**. Leave **Name on the sign-in page** as `Google`. Copy the redirect URI:

   ```text
   https://metrics.example.com/api/auth/callback/google
   ```

2. In the Google Cloud console open the **Google Auth Platform** **Clients** page. If it asks you to create a project or register the app, do that first.
3. Select **Create client** and choose the application type **Web application**.
4. Under **Authorized redirect URIs** add the address above, then select **Create**.
5. Copy the **Client ID** into **Client id**. Copy the **Client secret** into **Client secret of google**. Google shows the secret once.

Source: Google, [Manage OAuth Clients](https://support.google.com/cloud/answer/15549257).

### Add Okta, Auth0, Keycloak or another OpenID Connect provider

Any provider that serves an OpenID Connect discovery document works. The product asks for the scopes `openid`, `profile` and `email`, uses the authorization code flow with PKCE, and needs a confidential client (one with a secret).

1. In the admin section press **Add an OpenID Connect provider**. Enter a **Name on the sign-in page** (people see it on the button), and an **Id**: lower case letters, digits and underscores, such as `okta`. The id names the provider's secret and cannot change after you save.
2. Copy the redirect URI the admin section shows:

   ```text
   https://metrics.example.com/api/auth/sso/callback
   ```

3. In the provider, create a web application with that redirect URI.
   - **Okta**: in the Admin Console go to **Applications and Resources** > **Applications**, select **Create App Integration**, **Classic experience**, **OIDC - OpenID Connect**, then **Web Application**. Add the address under **Sign-in redirect URIs**. The issuer is your Okta domain, `https://example.okta.com`, or a custom authorization server such as `https://example.okta.com/oauth2/default`. Source: Okta, [Create OIDC app integrations](https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm) and [Authorization servers](https://developer.okta.com/docs/concepts/auth-servers/).
   - **Auth0**: in the Dashboard go to **Applications** > **Applications**, select **Create Application**, **Create it manually**, choose **Regular Web Applications** and select **Create**. The application's settings show **Domain**, **Client ID** and **Client Secret**, and take the address under **Allowed Callback URLs**. The issuer's discovery document is at `https://your-domain/.well-known/openid-configuration`. Source: Auth0, [Create Applications](https://auth0.com/docs/get-started/auth0-overview/create-applications), [Application Settings](https://auth0.com/docs/get-started/applications/application-settings) and [OIDC discovery](https://auth0.com/docs/get-started/applications/configure-applications-with-oidc-discovery).
   - **Keycloak**: create an OpenID Connect client in your realm with **Client authentication** switched on, which makes it a confidential client. Put the address in its **Valid Redirect URIs**, and read the secret on the client's **Credentials** tab. The issuer is `https://your-host/realms/your-realm`. Source: Keycloak, the Server Administration Guide on [creating an OpenID Connect client](https://www.keycloak.org/docs/latest/server_admin/index.html#proc-creating-oidc-client_server_administration_guide) and [client credentials](https://www.keycloak.org/docs/latest/server_admin/index.html#_client-credentials), and [OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers).
4. Copy the provider's client id into **Client id** and its secret into **Client secret of** your id.
5. In **Issuer** enter the issuer address. The check opens `<issuer>/.well-known/openid-configuration` and requires its `issuer` field to equal what you typed, character for character, so copy the `issuer` value from that document. A trailing slash counts.

### Email and password

Email and password sign-in is off by default and invite only. There is no sign-up form.
In **Settings > Authentication**, set the Resend key and a sender address on a domain verified in Resend under **Email**, then turn on **Password sign-in**. With the CLI:

```bash
pbmb admin secrets set resend_api_key
pbmb admin settings set email.from invites@example.com
pbmb admin settings set sign_in.email_password true
pbmb admin people invite reader@sample.example --role viewer
```

In **Settings > Users and roles**, choose **Invite people**, enter the emails and role, then press **Send invites**. The invite holds the role until a verified sign-in accepts it and lasts 7 days. **Resend** replaces the token; **Revoke** ends the invite. **Create invite link** works without email setup but cannot set a password, because the admin sees that link. See [people and invites](/docs/set-up/who-gets-in/#invite-people).

To check, open the invite from the mailbox, set a password of at least 12 characters, then sign out and sign in with it. **Forgot password** sends a link that works once for 1 hour. A person who signs in this way connects Power BI separately.

### Passkeys

Tick **Let people sign in with a passkey** to let a signed-in person add one. A passkey signs in only within 7 days of the person's last sign-in through a provider, and only when the device verified the person (a PIN, fingerprint or face). A passkey is bound to the host in `PUBLIC_BASE_URL`: changing the address makes every passkey stop working.

### Save and check

Press **Check the sign-in providers**. Each added provider's secret is saved with it, and the secret and its expiry date are checked daily.

## Check

The providers check passes when every added provider has a secret and every OpenID Connect issuer answers its discovery document. Then open `https://metrics.example.com/sign-in` in a private window and sign in through each provider once, as a test. Run the check again with:

```bash
pbmb admin check sign_in
```

A person who signs in with Google or OpenID Connect connects Power BI as a separate step, the first time a tool needs it, with the Microsoft account that has the same verified email. If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#sign-in).

Next: [Who gets in](/docs/set-up/who-gets-in/).
