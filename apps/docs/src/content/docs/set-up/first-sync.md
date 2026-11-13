---
title: First sync
description: Start the first sync, watch it run in the worker, and read what it found.
sidebar:
  order: 4.1
---

Screen 4 starts the first sync when you select **Start**. The screens after it follow it while it runs. The first sync reads every workspace you chose and groups the measures into drafts for your agent to describe. It runs in the worker and can take some minutes, longer for a large tenant.

The sync a deploy queues and the scheduled syncs are skipped until you select **Start**, and each skipped one is listed under the admin section's syncs with its reason. An admin can still run a sync by hand before that, from the admin section. It runs, and once it has started the deploy's and the scheduled syncs run too.

## Before you start

- [The scanner](/docs/set-up/scanner/) and [What to sync](/docs/set-up/what-to-sync/) have passed.
- The `worker` container is running: `docker compose ps` shows it healthy.

## Steps

1. On screen 4, **What to sync**, select **Start** once. The next screens, **Who gets in** and **Connect your agent**, show its progress while it runs.
2. The page shows progress while it runs:

   ```text
   The first sync is running: 12 workspaces scanned so far.
   ```

   The worker takes a token for the scanner, lists the workspaces, scans them in batches of 100 and stores the result. Power BI sets the pace: the worker waits for each scan to finish (up to 30 minutes), and waits out a rate limit when Power BI asks it to.
3. It ends in a count of what the sync found, such as:

   ```text
   214 measures in 12 datasets, 131 drafts ready for your agent.
   ```

   A draft is a group of measures that look like one calculation. Your agent structures them, and a curator approves them. Read [For curators: structuring drafts](/docs/use/for-curators-drafts/) next.
4. If the sync fails, its record says why. The admin section's status page and `pbmb sync status` show the newest runs, and a run names each workspace, dataset or app it could not read or store by its ID:

   ```bash
   pbmb sync status
   ```

   The others are mirrored all the same. Fix the cause, then run `pbmb sync run` or start it again in the admin section. A workspace that fails on every sync, or holds a dataset or app that does, can go under **Workspaces to skip** in the admin section, by the workspace ID the run names. The next full scan then removes that whole workspace from the book's mirror. Until it does, an app in that workspace that could not be stored keeps failing each run, and `pbmb sync run --full` saves the wait. A scan that fails as a whole, because Power BI refused it or did not answer, says how many workspaces it held. The worker's log names them and has more:

   ```bash
   docker compose logs worker
   ```

   An incremental sync reads only what changed since the last sync that succeeded, so it fails again on a workspace that changed and cannot be read. A full sync also reads the workspaces nothing changed in and every app's audience. If it fails on one of those, the incremental syncs after it can succeed, and the next full sync tries again. Until a full sync succeeds, the status page and `pbmb admin status` list `full_sync`.

A dataset that Power BI cannot describe in full (a model never refreshed, some DirectQuery models) keeps its last known schema, and the reason is shown with it. A failed read removes nothing.

## Check

The step passes when the last sync succeeded. You can start and follow a sync from a terminal too:

```bash
pbmb sync run
pbmb sync status
pbmb admin check first_sync
```

If you chose a search provider, the sync also embeds the book's search text now. Run the [Search](/docs/set-up/search/) check again for the real cost.

If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#first-sync).

If the sync fails, **The first sync failed** says why and **Back to What to sync** starts it again.

**What to do next**, the page **Start using the app** opens, keeps your next steps, and shows an admin any failing [Security](/docs/set-up/security/) items.
