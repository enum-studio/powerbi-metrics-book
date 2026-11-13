---
title: The scanner
description: Register a second app with no API permissions, put it in a security group, and turn on three Power BI tenant settings for that group.
sidebar:
  order: 3
---

Screen 2, **Connect your Microsoft tenant**, continues with **The scanner app**, **The scanner's security group** and **Three Power BI tenant settings**. Each item has **I have it** or **Make it**; the tenant settings use **They are on** or **Turn them on**. You can finish these before signing in.

You need an Entra account that can register apps and create security groups, and a Fabric Administrator to change the tenant settings.

## The scanner app

Reads the workspaces' tables, measures and DAX through Power BI's read-only admin APIs. It cannot read report data or change anything in Power BI. Its secret is encrypted for the worker only.

### If you already have it

1. [Open App registrations in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade). Select the app your Power BI admin API settings let in. Copy **Application (client) ID** from **Overview** into the scanner's field.
2. Check that it is a different registration from the sign-in app. The setup refuses the same client ID with "These are the same app. The scanner needs its own registration."
3. Under **API permissions**, check that it has no Power BI permission. The scanner needs no API permission; Power BI lets it in through the group below.
4. Paste the client secret you saved, or make a new one under **Certificates & secrets**. Copy **Value**, not **Secret ID**, into **Client secret value**. Optionally enter **The secret expires on** from **Expires**; left empty, the status page says the expiry is unknown.

### To make it

1. [Open New registration in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade). The page is titled **Register an application**. Use **Name** `Power BI Metrics Book scanner (metrics.example.com)`, replacing the host with yours. Leave **Supported account types** on **Single tenant only**. The dropdown also shows your company name. Leave **Redirect URI (optional)** empty and select **Register**.
2. Copy **Application (client) ID** from **Overview** into the scanner's field. Add no API permission. If the registration starts with Microsoft Graph `User.Read`, select its three dots, **Remove permission**, then **Yes, remove**. Leave the list empty.
3. Under **Certificates & secrets**, select **New client secret**, choose **24 months** and select **Add**. Copy **Value** into the scanner's **Client secret value**. The end date is optional.

## The scanner's security group

Power BI lets the scanner in through this group. It gives no person access: its member is the scanner app. The stack needs no group ID; the scanner check proves access.

### If you already have it

1. [Open Groups in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups). Find the group named in your Power BI admin API settings.
2. Under **Members**, check that the scanner app is a member. If missing, select **Add members** and search for it by name.

### To make it

1. [Open Groups in Entra](https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups) and select **New group**. Choose **Group type** **Security** and **Group name** `Power BI Metrics Book scanner (metrics.example.com)`, replacing the host with yours.
2. Under **Members**, select **Add members**, search for the scanner app by name and add it. Select **Create**. Keep only the scanner in this group.

## Three Power BI tenant settings

Power BI keeps its read-only admin APIs shut until these are on. They apply only to the security groups they name.

### If you already have it

[Open Tenant settings in Power BI](https://app.powerbi.com/admin-portal/tenantSettings). In **Admin portal**, **Tenant settings**, search for `admin API`. Under **Admin API settings**, check each setting below: **Enabled**, **Apply to**, **Specific security groups**, with the scanner's group named.

### To make it

On that same page, turn these on in order. For each, choose **Enabled**, then under **Apply to** choose **Specific security groups**, add the scanner's group and select **Apply**:

1. **Service principals can access read-only admin APIs**.
2. **Enhance admin APIs responses with detailed metadata**.
3. **Enhance admin APIs responses with DAX and mashup expressions**. Power BI shows this one once the previous one is on.

These let the group read metadata across the tenant, including people's names and emails. The scanner drops Power Query expressions before storing anything.

## Check

There are two checks, and each runs in the worker, the only container that can read the scanner's secret.

**Check the scanner app**, on the scanner app's section, proves only that Microsoft gives the registration a token. It takes a second or two, and passing it opens the security group's section. It passes with "The scanner registration gets a token from Microsoft."

**Check the scanner**, on the tenant settings' section, proves the group and the three settings. The worker checks a token, the workspace list and a scan of the first 10 listed workspaces your workspace selection chooses. A tenant setting can take up to 15 minutes to apply; during that time the screen says **Waiting for Microsoft, up to 15 minutes** and retries each minute.

The check passes with "The scanner read 3 of the 3 workspaces Power BI lists." If none of those workspaces has a table, it passes with "The tenant settings could not be proven, because no scanned workspace has a table." If your selection leaves nothing to scan, it passes with "The tenant settings could not be proven, because your workspace selection leaves nothing to scan." The first sync then shows whether tables and DAX come back. Entering new credentials ends the full check's pass, so run it again after them. Later, run `pbmb admin check scanner`. If a check fails, see [When a check fails](/docs/set-up/when-a-check-fails/#the-scanner).

## Only for service-account queries

After setup, in the admin section, skip this unless you turn on `powerbi.service_account_queries`. Service accounts then query as the first app registration's service principal, not as a person.


1. In **Tenant settings** > **Developer settings**, enable `Service principals can call Fabric public APIs` for the first app registration's service principal (put it in a security group and name the group). Older portals call it `Allow service principals to use Power BI APIs`.
2. In Power BI, open each workspace the queries may reach. From its **More** menu select **Workspace access**, add the first registration by its **Display name**, choose **Member**, and select **Add**.

Power BI does not run service-principal queries on a model with row-level security or single sign-on. The people who query those models use their own sign-in, and need the rights in [Running DAX for people](/docs/set-up/who-gets-in/#running-dax-for-people).

Source: Microsoft, [Set up service principal authentication for embedding](https://learn.microsoft.com/en-us/power-bi/developer/embedded/embed-service-principal) (steps 3 and 4) and [Datasets - Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries) (limitations).

Next: screen 3, [Sign in](/docs/set-up/sign-in/).
