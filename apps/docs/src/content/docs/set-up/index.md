---
title: Set up
description: Four setup screens, from the address to the first sync, with the same items and links as the product.
sidebar:
  order: 0
  label: Overview
---

The first run has six screens, with a guide beside the first four. Allow about 5 minutes when you already have the apps, or about 30 minutes from nothing. You need someone who can register apps in Microsoft Entra and grant admin consent, and a Fabric Administrator for the Power BI tenant settings. These can be different people.

Start with the [quickstart](/docs/start/quickstart/) if the stack is not running yet. Open setup with a one-time link, valid for 24 hours:

```bash
docker compose exec api server setup-link
```

On other platforms, run `server setup-link` in the api service. The [Deploy](/docs/deploy/) guides show how.

1. [Address](/docs/set-up/address/): checked on load, shown only when it needs a fix.
2. **Connect your Microsoft tenant**: five items. **Your tenant** has no choice of way. The sign-in app, scanner app and scanner's security group each offer **I have it** or **Make it**; the tenant settings offer **They are on** or **Turn them on**. [The app registration](/docs/set-up/app-registration/) covers your tenant and the sign-in app. [The scanner](/docs/set-up/scanner/) covers the scanner app, its security group and three Power BI tenant settings.
3. [Sign in](/docs/set-up/sign-in/): sign in with Microsoft, become the first admin and connect Power BI.
4. [What to sync](/docs/set-up/what-to-sync/): keep or change the ticked workspaces and select **Start** to begin the [first sync](/docs/set-up/first-sync/).

5. [Who gets in](/docs/set-up/who-gets-in/): choose the role everyone in your tenant signs in as, add anyone who needs more, and copy a message to send your colleagues. The first sync runs meanwhile, and this screen shows how far it has come.
6. [Connect your agent](/docs/set-up/agents/): the steps for Claude Code, Codex, Cursor or the command line, with your address. The screen sees it when your agent signs in. **Skip for now** passes it by.

Then **The setup is done** shows what is in place and offers **Start using the app** once the sync finishes. That opens **What to do next**, where each person sees their own next steps. Everyone in the tenant starts as a viewer.

The rail distinguishes **To do**, **Waiting for you**, **Waiting for Microsoft** on screen 2, **Waiting for the worker** on screen 4, **Done**, **Skipped** on screen 6 and **Failed**. A check waiting for you to act is not a failure. The **Do this now** guide follows the item you have open; on a phone it sits below that item.

After setup, use the admin section for [sign-in providers](/docs/set-up/sign-in/#sign-in-providers-in-the-admin-section), [who gets in](/docs/set-up/who-gets-in/) and [search](/docs/set-up/search/). These do not hold up the first run.

If a check fails, find its sentence in [When a check fails](/docs/set-up/when-a-check-fails/) and make the change it names.
