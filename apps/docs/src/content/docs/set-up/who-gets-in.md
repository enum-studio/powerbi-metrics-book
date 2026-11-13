---
title: Who gets in
description: Choose the default role for people in your tenant, give admins and curators their role, and choose who sees a dataset's description.
sidebar:
  order: 6
---

The first run asks who gets in on its **Who gets in** screen, and the admin section keeps it after that. New deployments start with only invited or assigned people; existing deployments keep their access choice. This page explains how to change who may use the book and what they see. Everyone in your tenant can get in with one role, or nobody until they are given one. Power BI still decides which datasets each person's queries can read.

## Before you start

- You are the admin (you became the first admin on [Sign in](/docs/set-up/sign-in/)).
- The email addresses of the curators who will review metrics, and any other admin.

## In the first run

**Who gets in** asks one thing and offers two more. Press **Continue: connect your agent** to save your choice.

- Choose **Only people I invite**, **Everyone at the company as Viewer**, or **as Curator**.
- **Who needs more**: enter an email and role, then press **Invite** to send an invite.
- **Tell your colleagues**: a message with your address, ready to copy.

The admin section keeps all of this after the first run.

## The three roles

| Role | Can |
|---|---|
| `viewer` | Read, search, query, ask and comment. |
| `curator` | Everything a viewer can, and change the book, verify as agent, accept and archive threads. |
| `admin` | Everything a curator can, and settings, secrets, conventions, people, service accounts, sync and audit. |

## Invite people

Open **Settings > Users and roles**. **Who can sign in** shows the current choice; **Change** lets you choose invited people only, everyone at the company as Viewer, or as Curator. With `access.default_role` set to `none`, explicit people, group and domain assignments still admit people.

1. Press **Invite people**, enter 1 to 50 emails separated by commas or spaces, and choose Viewer, Curator or Admin.
2. Press **Send invites** to email them. Set up the Resend key and sender in [Authentication](/docs/set-up/sign-in/#email-and-password) first. Without email setup, use **Create invite link** for one email and send it yourself.
3. Check **Pending invites** for email, role, inviter, last sent and expiry. Invites last 7 days and hold the role until accepted. A verified sign-in matching the invited email accepts it, even without opening the link. For Microsoft, use the email Entra verified (`xms_edov`), otherwise the UPN; see [the sign-in app](/docs/set-up/app-registration/).

Only an emailed invite can set a password when password sign-in is on. An admin can see a link invite, so that link cannot prove mailbox ownership. People with an existing provider account use that provider.

## Pending invites

**Resend** replaces the token and restarts the 7 days. A link invite returns a new link to copy; the old one stops working. Resend allows once a minute and 10 times a day per invite. **Revoke** ends the invite at once. Expired invites stay listed until resent or revoked. To change an active user's role, use **Users**; to invite a deactivated user back, reactivate them.

## Groups and domains

Open **Settings > Users and roles > Groups and domains**. Choose the **Role**, choose **Given to**, fill in the boxes that appear and press **Add assignment**:

- **A person**: their email, as they sign in. Matches only a verified email.
- **An email domain**: the domain after the `@`, such as `sample.example`. It counts for people who sign in with Microsoft, an OpenID Connect provider that verifies the email, or a Google Workspace account of that domain. A personal Google account vouches for no domain. Admin and PII roles cannot go to an email domain.
- **A group**: enter `microsoft` as the **Sign-in provider** for an Entra group, then the group's Object ID. In the [Microsoft Entra admin center](https://entra.microsoft.com) browse to **Entra ID** > **Groups** > **All groups**, select the group, choose **Properties** and copy **Object ID**. Nested groups count. Groups are read from the person's own Power BI connection when they connect and again each day they are active.
Everyone in your Power BI tenant is not an assignment here: choose it under **Who can sign in** at the top of the page. Admin and PII roles never go to everyone in the tenant.

Source for the Object ID: Microsoft, [Manage Microsoft Entra groups and group membership](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-groups), under **Edit group settings**.

Press **Revoke** beside an assignment to take a role away. The last admin assignment cannot be revoked.

## Users, roles and removal

In **Users**, choose the person's direct role. Inherited roles show their source and must be changed there, under **Groups and domains**. **Can read PII** is separate; admins do not receive it automatically. Open a person to see every role, Power BI connection, and MCP and CLI grants with **Revoke**.

**Sign out** is for a lost or shared device. A sign-in lasts 7 days, and Sign out ends all of the person's sessions now and revokes their MCP and CLI grants, so they sign in again everywhere. Their roles, invites and Power BI connection stay, and they can sign in again at once. You cannot sign yourself out here: use **Sign out of all other sessions** under **Connections > Sessions**, which ends your other browser sessions and keeps this one.

**Deactivate** blocks sign-in despite any assignment, group, domain or default role. It ends all sessions, revokes MCP and CLI grants and ends the Power BI connection. Assignments and history stay. It leaves the service accounts the person owns working: open **Service accounts**, and revoke or rotate the keys of any they own. You cannot deactivate yourself or the last active admin. **Reactivate** restores assignments; the person must sign in and reconnect Power BI.

**Delete** is available only after deactivation and asks you to type the email. It removes the account and person assignments. Book history says "a removed person"; the audit log keeps its record, including email. If a group, domain or default role still reaches the email, that person can join again as a new user.

## General branding

Open **Settings > General**. Set **Brand name**, and **Company name** for the Microsoft sign-in prompt, and upload a PNG, JPEG or WebP logo of at most 256 KB. A square works best; it appears at 40 pixels high. SVG and logo URLs are refused. `branding.name` supplies the displayed name, falling back to Power BI Metrics Book; `branding.company` supplies the company in the Microsoft sign-in prompt, falling back to the host.

The name and logo appear on sign-in, invite and password pages, the app header, browser titles, and invite and reset emails. Colors stay the product's own. Check the sign-in page in a private window after saving. `pbmb whoami` and MCP instructions keep the product name.

## Who sees a dataset's description

| Choice in the admin section | Setting value | A person may see a dataset when | Fits |
|---|---|---|---|
| **Those Power BI lets read the dataset** | `powerbi` | Power BI lets them reach it: through a workspace they are in, an app whose audience they are in, or a direct share. Groups count. | A company that wants the book to show each person what Power BI shows them. |
| **Everyone who gets in** | `everyone` | They are signed in. | A small company, or a book everyone may read. |
| **Whoever the access policy says** | `policy` | Your own Cerbos policy says so, by workspace, app, endorsement, sensitivity label or a custom field. | A company with its own rules. See [Roles and policies](/docs/make-it-yours/roles-and-policies/). |

Companies share Power BI in two ways, and most use both. Workspaces give people a role in the workspace. Apps give people a place in an app's audience. `powerbi` follows both: the sync reads each workspace's access list and each app's audience, so people who reach a dataset only through an app see it too. These lists are as fresh as the last sync (an hour by default). A company that decides by something else than Power BI access chooses `policy`.

## Running DAX for people

A person can only run queries through the book when Power BI allows it. Two things must be true. Both are Power BI's rules, and Power BI checks them at the moment of every query.


1. **The tenant setting `Semantic Model Execute Queries REST API`** is on. It is on by default, under **Integration settings** in the tenant settings. Check it if queries fail for everyone. (Older pages call it `Dataset Execute Queries REST API`.)
2. **The person has Read and Build permission on the semantic model.** They have it when they:
   - hold at least the Contributor role in the model's workspace, which gives Build on every model in it; or
   - were given Build on the model by its owner, on the model's **Manage permissions** page; or
   - are in the audience of an app published with **Allow users to build content with the semantic models in this app** ticked (under **Advanced** in **Manage audience access**). That applies to models in the app's own workspace. For models in another workspace, grant Build on the model itself.

For a company that shares through apps: Build is granted when the app is published to its audience. Removing someone from the audience does not take it back. To take it back, remove their Build permission on the model itself, from the model's **Manage permissions** page.

Source: Microsoft, [Datasets - Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries), [Build permission for shared semantic models](https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-build-permissions) (**How users get Build permission**) and [Create and distribute workspace apps](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-create-distribute-apps) (**Create and manage multiple audiences**).

## Check

Check that a new invitation appears under **Pending invites**. After the recipient signs in with the invited verified email, check that they appear under **Users** with the chosen role. Under **Groups and domains**, review **Who would get in** against your access choice. You can also check assignments from a terminal:

```bash
pbmb admin check who_gets_in
pbmb admin roles list
pbmb admin roles assign curator --person ada@sample.example
```

Next: [Search](/docs/set-up/search/).
