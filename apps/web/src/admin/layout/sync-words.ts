import type { SyncRun } from "../settings/api";

/** What started a sync, in the words of the sentence that names it. */
export const TRIGGER_WORDS: Record<SyncRun["trigger"], string> = {
  schedule: "on schedule",
  manual: "started by an admin",
  deploy: "started when the stack started",
};

const many = (n: number, one: string, other: string) =>
  `${String(n)} ${n === 1 ? one : other}`;

/** Counts that share a prefix are said together: "Metric drafts: 3 created, 1 filed". */
const GROUPS = [
  { prefix: "items_", lead: "Tables, columns and measures" },
  { prefix: "drafts_", lead: "Metric drafts" },
] as const;

const SINGLES: Record<string, (n: number) => string> = {
  workspaces_removed: (n) =>
    `${many(n, "workspace is", "workspaces are")} gone from the tenant`,
  apps: (n) => `${many(n, "app", "apps")} read`,
  datasets_changed: (n) => `${many(n, "dataset", "datasets")} changed`,
  access_without_right: (n) =>
    n === 1
      ? "1 access entry names no access right, so it opens nothing"
      : `${String(n)} access entries name no access right, so they open nothing`,
  access_lists_unsent: (n) =>
    n === 1
      ? "Power BI sent no access list for 1 workspace or dataset, so its stored access is unchanged"
      : `Power BI sent no access list for ${String(n)} workspaces or datasets, so their stored access is unchanged`,
  workspaces_failed: (n) =>
    n === 1
      ? "1 workspace could not be read or stored, so it stays as it was"
      : `${String(n)} workspaces could not be read or stored, so they stay as they were`,
  datasets_failed: (n) =>
    n === 1
      ? "1 dataset could not be stored, so it stays as it was"
      : `${String(n)} datasets could not be stored, so they stay as they were`,
  batches_failed: (n) =>
    n === 1
      ? "1 scan batch failed, so its workspaces stay as they were"
      : `${String(n)} scan batches failed, so their workspaces stay as they were`,
  apps_failed: (n) =>
    n === 1
      ? "1 app could not be read or stored in full, so what failed of it stays as it was"
      : `${String(n)} apps could not be read or stored in full, so what failed of them stays as it was`,
  apps_not_synced: () =>
    "The apps could not be synced, so they may be out of date",
};

/** Said in the "Read N workspaces" part of the sentence already. */
const SAID_ELSEWHERE = "workspaces_scanned";

/**
 * A sync run's counts as clauses an admin reads, in the order the sync made
 * them. A count of zero is left out; a count with no words here is kept under
 * its own name rather than dropped.
 */
export function syncCounts(counts: Record<string, number>): string[] {
  const clauses: string[] = [];
  const said = new Set<string>();
  for (const [key, n] of Object.entries(counts)) {
    if (n === 0 || key === SAID_ELSEWHERE) continue;
    const group = GROUPS.find(({ prefix }) => key.startsWith(prefix));
    if (group === undefined) {
      clauses.push(
        SINGLES[key]?.(n) ?? `${String(n)} ${key.replaceAll("_", " ")}`,
      );
    } else if (!said.has(group.prefix)) {
      said.add(group.prefix);
      const parts = Object.entries(counts)
        .filter(([each, count]) => each.startsWith(group.prefix) && count > 0)
        .map(
          ([each, count]) =>
            `${String(count)} ${each.slice(group.prefix.length)}`,
        );
      clauses.push(`${group.lead}: ${parts.join(", ")}`);
    }
  }
  return clauses;
}
