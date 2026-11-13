import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { COLUMN_TYPES } from "../db/schema/mirror.js";
import { ServiceError } from "../errors.js";
import { accessList, ADMIN_API, requestAdmin } from "./admin.js";
import { parseAnswer } from "./errors.js";
import type { PowerBiDeps } from "./identity.js";

/*
 * The Admin Scanner API: which workspaces changed, a scan of up to 100 of
 * them, its status, and its result.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-post-workspace-info
 */

const WORKSPACES_PER_SCAN = 100;
const MINUTE_MS = 60_000;
/** The fetcher's ceiling: a scan of 100 workspaces with their schemas is large. */
const SCAN_RESULT_MAX_BYTES = 32 * 1024 * 1024;
/** The fetcher's ceiling: an answer that large must not fail on a slow link. */
const SCAN_RESULT_TIMEOUT_MS = 300_000;
/** The marker in the detail of a scan that failed or ran out of time, whose message holds Microsoft's text: a check says its own sentence for it. */
export const SCAN_UNFINISHED = "unfinished";
/** Lineage and data source details are not asked for: nothing reads them. */
const SCAN_QUERY = new URLSearchParams({
  lineage: "false",
  datasourceDetails: "false",
  datasetSchema: "true",
  datasetExpressions: "true",
  getArtifactUsers: "true",
}).toString();

/** Power BI's spelling of an enumeration (`PersonalGroup`) as the mirror stores it (`personal_group`). */
export function mirrorSpelling(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/*
 * The scan result as the sync reads it. Keys stay Microsoft's; the values
 * the mirror stores as enumerations are mapped to its spelling. No schema
 * here declares a table's `source` or a dataset's `expressions`, and zod
 * drops keys a schema does not declare, so Power Query (M), which names
 * servers and sometimes carries connection details, never leaves this
 * module.
 */
const text = z.string().optional();
const flag = z.boolean().optional();
const enumeration = z.string().transform(mirrorSpelling);
const column = z.object({
  name: z.string(),
  dataType: z.string(),
  description: text,
  isHidden: flag,
  columnType: enumeration.pipe(z.enum(COLUMN_TYPES)).optional(),
  expression: text,
  formatString: text,
});
const measure = z.object({
  name: z.string(),
  expression: text,
  description: text,
  formatString: text,
  isHidden: flag,
});
const table = z.object({
  name: z.string(),
  description: text,
  isHidden: flag,
  columns: z.array(column).optional(),
  measures: z.array(measure).optional(),
});
/** In Microsoft's sample answer but not its schema; an empty list means the scanner gave none. */
const relationship = z.object({
  name: text,
  fromTable: z.string(),
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
  crossFilteringBehavior: enumeration.optional(),
});
/**
 * A list the scanner answers as null (some workspaces, with getArtifactUsers)
 * is a list it did not give, the same as a missing key: the sync keeps the
 * stored rows for either, and neither revokes anyone.
 */
const users = z.preprocess((list) => list ?? undefined, accessList.optional());
const dataset = z.object({
  id: z.string(),
  name: z.string(),
  description: text,
  configuredBy: text,
  targetStorageMode: enumeration.optional(),
  tables: z.array(table).optional(),
  relationships: z.array(relationship).optional(),
  schemaRetrievalError: text,
  schemaMayNotBeUpToDate: flag,
  users,
});
const report = z.object({
  id: z.string(),
  name: z.string(),
  datasetId: text,
  appId: text,
});
const workspace = z.object({
  id: z.string(),
  name: z.string(),
  type: enumeration.optional(),
  state: enumeration,
  reports: z.array(report).optional(),
  datasets: z.array(dataset).optional(),
  users,
});
const scanResultSchema = z.object({ workspaces: z.array(workspace) });
/** A scan's answer at all, whatever its workspaces hold: a gateway's page is not one. */
const scanAnswer = z.object({ workspaces: z.array(z.unknown()) });
export type ScanResult = z.output<typeof scanResultSchema>;

const modified = z.array(z.object({ id: z.string() }));
const scanRequest = z.object({
  id: z.string(),
  status: z.string(),
  error: z.object({ code: z.string(), message: text }).optional(),
});

/** Workspaces changed since a moment Microsoft wants 30 minutes to 30 days old, or all of them. */
export async function modifiedWorkspaces(
  deps: PowerBiDeps,
  options: { since: Date | null },
): Promise<string[]> {
  const personal = await deps.settings.get("powerbi.sync.workspaces.personal");
  const query = new URLSearchParams({
    excludePersonalWorkspaces: String(!personal),
    excludeInActiveWorkspaces: "true",
  });
  // Microsoft accepts exactly seven fractional digits; toISOString writes three.
  if (options.since)
    query.set(
      "modifiedSince",
      `${options.since.toISOString().slice(0, -1)}0000Z`,
    );
  const path = `/workspaces/modified?${query.toString()}`;
  const body = await requestAdmin(deps, path);
  return parseAnswer(modified, body, ADMIN_API).map((entry) => entry.id);
}

/** Starts a scan of 1 to 100 workspaces and answers its id. */
export async function startScan(
  deps: PowerBiDeps,
  workspaceIds: string[],
): Promise<string> {
  const count = workspaceIds.length;
  if (count < 1 || count > WORKSPACES_PER_SCAN) {
    throw new RangeError(
      `A scan takes 1 to 100 workspaces, not ${String(count)}.`,
    );
  }
  const body = await requestAdmin(deps, `/workspaces/getInfo?${SCAN_QUERY}`, {
    json: { workspaces: workspaceIds },
  });
  return parseAnswer(scanRequest, body, ADMIN_API).id;
}

/** Polls the scan's status until it succeeds: every 30 seconds, for 30 minutes at most, by default. */
export async function waitForScan(
  deps: PowerBiDeps,
  scanId: string,
  options: { poll_ms?: number; timeout_ms?: number } = {},
): Promise<void> {
  const { poll_ms = 30_000, timeout_ms = 30 * MINUTE_MS } = options;
  const deadline = deps.clock().getTime() + timeout_ms;
  const path = `/workspaces/scanStatus/${encodeURIComponent(scanId)}`;
  for (;;) {
    const body = await requestAdmin(deps, path, { deadline });
    const scan = parseAnswer(scanRequest, body, ADMIN_API);
    if (scan.status === "Succeeded") return;
    if (scan.status === "Failed") {
      const said = scan.error?.message ?? scan.error?.code ?? "no reason given";
      const sentence = `Power BI's scan ${scanId} failed: ${said}.`;
      throw new ServiceError("upstream", sentence, {
        scan: SCAN_UNFINISHED,
        scan_failed: true,
      });
    }
    if (deps.clock().getTime() + poll_ms > deadline) {
      const minutes = String(Math.round(timeout_ms / MINUTE_MS));
      const sentence = `Power BI's scan ${scanId} did not finish within ${minutes} minutes.`;
      throw new ServiceError("upstream", sentence, { scan: SCAN_UNFINISHED });
    }
    await sleep(poll_ms);
  }
}

/**
 * Whether one workspace may have spoiled this scan, so smaller scans of the
 * same workspaces may go through: its answer passed the limit, or held a
 * workspace this version cannot read, or Power BI says it failed. A refused or
 * unanswered request, a scan out of time and a gateway's page say nothing
 * about what the scan held.
 */
export function mayBeOneWorkspace(error: ServiceError): boolean {
  const { detail } = error;
  return (
    detail.too_large === true ||
    detail.scan_failed === true ||
    detail.scan_unreadable === true
  );
}

/** The result of a scan that succeeded, kept by Microsoft for 24 hours. */
export async function scanResult(
  deps: PowerBiDeps,
  scanId: string,
): Promise<ScanResult> {
  const path = `/workspaces/scanResult/${encodeURIComponent(scanId)}`;
  const body = await requestAdmin(deps, path, {
    max_bytes: SCAN_RESULT_MAX_BYTES,
    timeout_ms: SCAN_RESULT_TIMEOUT_MS,
  });
  parseAnswer(scanAnswer, body, ADMIN_API);
  return parseAnswer(scanResultSchema, body, ADMIN_API, {
    scan_unreadable: true,
  });
}
