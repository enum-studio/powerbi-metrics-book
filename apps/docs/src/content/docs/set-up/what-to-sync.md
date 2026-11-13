---
title: What to sync
description: Choose which workspaces the sync reads, whether it reads personal workspaces, and when it runs.
sidebar:
  order: 4
---

Screen 4, **What to sync**, lists the workspaces the scanner found. All are ticked, personal workspaces are off, and the default schedule runs every hour. Keep these choices or change them, then select **Start**.

## Before you start

- [The scanner](/docs/set-up/scanner/) has passed. This check asks Power BI for the workspace list as the scanner.
- For later changes by ID in the admin section, use the workspace ids. Open a workspace's report in Power BI: the id is the part of the address between `/groups/` and `/reports/`. A Power BI admin can also copy it from **Details** beside the workspace's name in the admin portal.


Source for the workspace id: Microsoft, [Embed for your customers](https://learn.microsoft.com/en-us/power-bi/developer/embedded/embed-sample-for-customers), under **Workspace ID**.

## Steps

1. On screen 4, **What to sync**, keep or change the ticked workspaces. Select at least one.
2. Leave unticked any workspace the scanner must not read. Later, the admin section also accepts IDs under **Only these workspaces** and **Workspaces to skip**. An excluded workspace is skipped even when included.
3. Tick **Also sync people's personal workspaces** only if the book should describe models people keep in My workspace. It is off by default.
4. **When the sync runs** is a cron line, in the containers' time zone, which is UTC unless you set one. The default runs at the start of every hour:

   ```text
   0 * * * *
   ```

   The default is right for most companies. Power BI limits the list of changed workspaces to 30 calls an hour, so do not run it more often than that. A full scan also runs every night at 02:30 (`powerbi.sync.full_scan_schedule`, default `30 2 * * *`), and you can start a sync by hand with `pbmb sync run`.
5. Select **Start**. It saves your choices and starts the [first sync](/docs/set-up/first-sync/). The worker runs the checks and the page follows its progress.

A change in Power BI shows in the book within one scheduled sync, an hour by default.

## Turn datasets on or off

To use the admin screen instead of the CLI, see [Datasets on or off](/docs/set-up/datasets-on-or-off/).

The workspace filter (`powerbi.sync.workspaces.include` and `.exclude`) chooses what the scanner reads. To hide one dataset while keeping its mirror current, turn that dataset off instead. As an admin on the sample tenant:

```bash
pbmb admin datasets list
pbmb admin datasets off Sales
pbmb admin datasets list --off
```

Sales now appears with `enabled: false` in the admin list. It disappears from metadata, search and book variants for everyone, including admins, and cannot be queried. The sync keeps reading it. The admin list shows every live dataset's name, workspace and counts, even beyond the admin's own Power BI rights; it shows no query data. Use a dataset id if several datasets share a name.

Turn it back on and check that it returns:

```bash
pbmb admin datasets on Sales
pbmb datasets show Sales
```

The metadata returns immediately for people with access. Search documents are rebuilt after either switch. Query log entries keep naming datasets that have been turned off.

New datasets start on by default. To review each new dataset before showing it:

```bash
pbmb admin settings set powerbi.datasets.new off
pbmb admin settings get powerbi.datasets.new
```

The answer is `off`. This setting affects only datasets first found by a later sync; it does not change existing ones. Set it to `on` to restore the default. Dataset switches are specific to this tenant and are not exported in `book.yml`.

For queries off while metadata stays visible and searchable, use the lighter `custom.queries_off` policy described in [Custom fields](/docs/make-it-yours/custom-fields/#use-a-field-in-a-policy). A custom policy cannot expose a dataset turned off by `pbmb admin datasets off`.

## Check

The step passes with "The first sync scans N of the M workspaces Power BI lists." Read the two numbers: N is what your choices select, and M is every workspace the scanner can see. If N is not what you expect, change the selected workspaces and try again. You can also run:

```bash
pbmb admin check what_to_sync
```

If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#what-to-sync).

Next: [First sync](/docs/set-up/first-sync/), [Who gets in](/docs/set-up/who-gets-in/) and [Connect your agent](/docs/set-up/agents/).
