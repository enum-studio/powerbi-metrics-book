---
title: The app registration
description: Register the app in the Microsoft Entra admin center with its two redirect URIs, read-only delegated permissions, admin consent and a client secret.
sidebar:
  order: 2
---

Screen 2, **Connect your Microsoft tenant**, starts with **Your tenant** and **The sign-in app**. The next three items are in [The scanner](/docs/set-up/scanner/). No sign-in is needed yet.

Answer **Have you set these up before, for this or another tool?** Yes opens the items on **I have it**; No opens them on **Make it**. Each item can switch on its own. Finishing one opens the next, and **Do this now** follows it.

## Your tenant

Every other item lives in your Microsoft tenant, and people sign in through it. The stack signs people in through your tenant and only your tenant.

### If you already have it

[Open Overview in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_IAM/TenantOverview.ReactView). Copy **Tenant ID** into the setup. Check that you are in the tenant where your Power BI lives.

### To make it

Type your work email. Only its domain is used to find the tenant ID; this does not create a tenant. Check the returned domain and tenant ID against **Tenant ID** on the Overview page in Entra. If they differ, paste the one from Entra.

## The sign-in app

People sign in with Microsoft through it, and query Power BI as themselves. This product only reads Power BI, and asks for nothing beyond `Dataset.Read.All` and sign-in. Whatever else the app registration holds, the app can still do, whether or not the setup shows a note: a permission held for another product reaches this app's tokens too. The check reads only what tokens for Power BI show, so it says nothing about permissions on other resources, such as Microsoft Graph.

### If you already have it

1. [Open App registrations in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade). Select your sign-in app and copy **Application (client) ID** from its **Overview** into the setup. Once entered, the screen's **Open this app's Overview** link opens that app directly.
2. Under **Authentication (Preview)**, open the **Redirect URI configuration** tab and check that both redirect URIs below are listed as **Web**. Select **Add Redirect URI** to add any that is missing. Use your deployment's address, as shown by the setup:

   ```text
   https://metrics.example.com/api/auth/callback/microsoft
   https://metrics.example.com/api/v1/powerbi/callback
   ```

3. Under **API permissions**, check the delegated permissions: Power BI Service `Dataset.Read.All`, and Microsoft Graph `openid`, `profile`, `email`, `offline_access`, `User.Read`. Each must show **Granted for** your company. This app needs no more than these. If the app also serves another product and holds more, leave them: the check passes and names each one as not needed.
4. Paste the client secret you saved into **Client secret value**. If you no longer have it, use **Certificates & secrets** > **New client secret** and copy its **Value**, not its **Secret ID**. Entra shows the value only when it is made.
5. Optionally enter **The secret expires on**, using **Expires** in Entra. Left empty, the status page says the expiry is unknown. The screen's **Open this app's Authentication**, **Open this app's API permissions** and **Open this app's Certificates & secrets** links go to the selected app.
6. Under **Token configuration**, check that the **ID** token has the optional claim `xms_edov`, or select **Add optional claim**, **ID**, `xms_edov`, **Add**. It says whether Entra verified the domain of a person's email. Without it, every Microsoft sign-in matches the person by their user principal name (UPN), never their email: an unchecked email gets nobody in, but a role given to an email that is not the UPN does not reach them. Before you upgrade a deployment that ran without it, check that each admin's email in **Users and roles** is their UPN, or add the claim first: an admin whose email stops matching loses admin at their next sign-in.

These app addresses are templates. Replace `CLIENT_ID` with **Application (client) ID** before opening an address. The setup fills it in for you:

- Open this app's Overview: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/CLIENT_ID`.
- Open this app's Authentication: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Authentication/appId/CLIENT_ID`.
- Open this app's API permissions: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/CLIENT_ID`.
- Open this app's Certificates & secrets: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/CLIENT_ID`.

### To make it

1. [Open New registration in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade). The page is titled **Register an application**. Use **Name** `Power BI Metrics Book (metrics.example.com)`, replacing the host with yours. Leave **Supported account types** on **Single tenant only**. The dropdown also shows your company name. Under **Redirect URI (optional)**, use **Select a platform** to select **Web** and paste the first redirect URI above. Select **Register**.
2. On the new app's **Overview**, copy **Application (client) ID** into the setup.
3. Under **Authentication (Preview)**, open the **Redirect URI configuration** tab and select **Add Redirect URI**. Select **Web** and paste the second redirect URI above.
4. Under **API permissions**, select **Add a permission**, **Power BI Service**, **Delegated permissions**, `Dataset.Read.All`. Then add Microsoft Graph delegated permissions `openid`, `profile`, `email`, `offline_access`, `User.Read`. Keep only these permissions.
5. Select **Grant admin consent for** your company, confirm, and check that each permission shows **Granted for** your company.
6. Under **Certificates & secrets**, select **New client secret**, choose **24 months**, then **Add**. Copy its **Value** into **Client secret value**. The end date is optional; enter it to receive expiry warnings.
7. Under **Token configuration**, select **Add optional claim**, **ID**, `xms_edov`, **Add**. Without it, sign-in matches people by their UPN, never their email.

## Check

Select **Check the app registration**. The check asks Microsoft for a token with the tenant ID, client ID and secret. It checks delegated permissions after [Sign in](/docs/set-up/sign-in/), when your own Power BI token exists.

Later, run `pbmb admin check app_registration` or `pbmb admin status`. Status warns 30 and 7 days before a known expiry. To renew, make a new secret under **Certificates & secrets** and enter it in the admin section. If a check fails, see [When a check fails](/docs/set-up/when-a-check-fails/#the-app-registration).

Next on screen 2: [The scanner](/docs/set-up/scanner/).
