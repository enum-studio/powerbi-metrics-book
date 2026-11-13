import { describe, expect, it } from "vitest";
import { syncCounts, TRIGGER_WORDS } from "./sync-words";

describe("syncCounts", () => {
  it("says what the sync found in sentences an admin reads, and leaves out zeros", () => {
    expect(
      syncCounts({
        workspaces_scanned: 3,
        items_added: 40,
        items_changed: 2,
        items_removed: 0,
        items_renamed: 0,
        workspaces_removed: 1,
        apps: 5,
        access_without_right: 0,
        datasets_changed: 2,
        drafts_created: 3,
        drafts_filed: 1,
        drafts_deleted: 0,
      }),
    ).toEqual([
      "Tables, columns and measures: 40 added, 2 changed",
      "1 workspace is gone from the tenant",
      "5 apps read",
      "2 datasets changed",
      "Metric drafts: 3 created, 1 filed",
    ]);
  });

  it("explains the access entries that give no one access", () => {
    expect(syncCounts({ access_without_right: 4 })).toEqual([
      "4 access entries name no access right, so they open nothing",
    ]);
    expect(syncCounts({ access_without_right: 1 })).toEqual([
      "1 access entry names no access right, so it opens nothing",
    ]);
  });

  it("says when Power BI sent no access list, so stored access stays as it was", () => {
    expect(syncCounts({ access_lists_unsent: 0 })).toEqual([]);
    expect(syncCounts({ access_lists_unsent: 1 })).toEqual([
      "Power BI sent no access list for 1 workspace or dataset, so its stored access is unchanged",
    ]);
    expect(syncCounts({ access_lists_unsent: 3 })).toEqual([
      "Power BI sent no access list for 3 workspaces or datasets, so their stored access is unchanged",
    ]);
  });

  it("says what the sync left as it was", () => {
    expect(
      syncCounts({
        workspaces_failed: 1,
        datasets_failed: 2,
        batches_failed: 3,
        apps_failed: 4,
        apps_not_synced: 1,
      }),
    ).toEqual([
      "1 workspace could not be read or stored, so it stays as it was",
      "2 datasets could not be stored, so they stay as they were",
      "3 scan batches failed, so their workspaces stay as they were",
      "4 apps could not be read or stored in full, so what failed of them stays as it was",
      "The apps could not be synced, so they may be out of date",
    ]);
  });

  it("keeps a count it has no words for, rather than dropping it", () => {
    expect(syncCounts({ reports_read: 7 })).toEqual(["7 reports read"]);
  });
});

describe("TRIGGER_WORDS", () => {
  it("names what started a sync, not the internal word", () => {
    expect(TRIGGER_WORDS).toEqual({
      schedule: "on schedule",
      manual: "started by an admin",
      deploy: "started when the stack started",
    });
  });
});
