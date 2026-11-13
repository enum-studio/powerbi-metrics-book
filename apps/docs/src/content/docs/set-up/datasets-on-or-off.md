---
title: Datasets on or off
description: Use Admin to hide a dataset or choose whether newly found datasets start on.
sidebar:
  order: 4.5
---

Turn a dataset off to remove it from the catalog, search and agents for everyone, including admins. Queries against it are refused. The sync keeps reading it, so turning it on restores access immediately for people who may see it. It is drafted again straight away, with no scan, so a draft nobody worked on follows the rules as they are now.

![Admin Datasets, with the new dataset setting and switches grouped by workspace.](/docs/screenshots/admin-datasets.png)

## Change a dataset

1. Sign in as an admin. Open **Settings**, then **Datasets**.
2. Under **All datasets**, use **Find a dataset** to filter by name. Use **All**, **On** or **Off** to filter by state.
3. Find the dataset under its workspace. Check its table, column and measure counts and **Synced** time.
4. Change its switch. **On** or **Off** beside the switch shows the new state. The change acts at once, and a message tells you what happened. Choose **Undo** in that message to reverse it.

This admin list includes datasets beyond your own Power BI reach. It shows names and counts, not query data. An on dataset's name links to the catalog, where your own access still applies. An off dataset's name has no link. Search documents are rebuilt after a switch, and old query log entries keep the dataset's name.

The admin PII page still lists an off dataset's column names in its suggestions and coverage.

## Choose how new datasets start

Under **New datasets**, choose **On** or **Off** after **A dataset the sync finds for the first time starts**. The change saves immediately. It affects only datasets first found by a later sync. Existing datasets keep their state.

Choose **Off** if you want to review each new dataset before people and agents use it. Choose **On** to restore the default. These switches belong to this tenant and are not exported in `book.yml`.

The workspace filter chooses what the scanner reads. A dataset switch chooses what the product exposes. See [What to sync](/docs/set-up/what-to-sync/#turn-datasets-on-or-off) for the equivalent CLI commands and the workspace filter.

## Check on the sample tenant

Turn **Sales** off. The message says it is off, and the row reads **Off**. Open **Datasets** in the left bar and check that Sales is absent from it. Return to **Datasets** in **Settings** and turn Sales on. Its name becomes a link again, and it returns to the catalog for people with access.
