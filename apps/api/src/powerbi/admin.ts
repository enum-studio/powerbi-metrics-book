import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { PRINCIPAL_TYPES } from "../db/schema/mirror.js";
import { ServiceError } from "../errors.js";
import {
  parseAnswer,
  readJson,
  readMicrosoftError,
  retryAfterSeconds,
  upstreamFailure,
} from "./errors.js";
import { endpoint, scannerToken, type PowerBiDeps } from "./identity.js";

export const ADMIN_API = "Power BI's admin API";
const ADMIN_PATH = "/v1.0/myorg/admin";
const ATTEMPTS = 3;
/** Microsoft's own polling interval for the scanner, for a 429 that names no wait. */
const DEFAULT_WAIT_SECONDS = 30;
const PAGE_SIZE = 5_000;

/**
 * One admin API call with the scanner's token. A 429 waits its Retry-After
 * and tries again, up to three times, and never past the deadline.
 */
export async function requestAdmin(
  deps: PowerBiDeps,
  path: string,
  options: {
    json?: unknown;
    deadline?: number;
    max_bytes?: number;
    timeout_ms?: number;
  } = {},
): Promise<unknown> {
  const url = await endpoint(deps, "powerbi.api_url", ADMIN_PATH + path);
  const json = options.json === undefined ? null : JSON.stringify(options.json);
  for (let attempt = 1; ; attempt += 1) {
    const response = await deps.fetcher.fetchFixed(url, {
      method: json === null ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${await scannerToken(deps)}`,
        "content-type": "application/json",
      },
      body: json,
      max_bytes: options.max_bytes,
      timeout_ms: options.timeout_ms,
    });
    const body = await readJson(response);
    if (response.ok) return body;
    if (response.status !== 429) {
      throw upstreamFailure(
        ADMIN_API,
        response.status,
        readMicrosoftError(body),
      );
    }
    const seconds = retryAfterSeconds(response) ?? DEFAULT_WAIT_SECONDS;
    const resumes = deps.clock().getTime() + seconds * 1000;
    if (attempt === ATTEMPTS || resumes > (options.deadline ?? Infinity)) {
      throw new ServiceError(
        "rate_limited",
        `${ADMIN_API} is limiting calls. Try again in ${String(seconds)} seconds.`,
        { retry_after_seconds: seconds },
      );
    }
    await sleep(seconds * 1000);
  }
}

const PRINCIPAL_TYPE = { User: "user", Group: "group", App: "app" } as const;

/** One line of an access list as the mirror's powerbi_access stores it. */
export type AccessEntry = {
  principal_type: (typeof PRINCIPAL_TYPES)[number];
  principal_object_id: string;
  email: string | null;
  access_right: string | null;
};

/**
 * A workspace's, dataset's or app's access list. The right's key is read
 * from whichever key ends in UserAccessRight, since Microsoft's own samples
 * use appUserAccessRight on workspace users and datamartUserAccessRight
 * under Users; an entry with none keeps a null right, which reaches
 * nothing. An entry for the whole organization (principalType None) names
 * no principal, so it gives no one visibility here; Power BI still decides
 * every query. A group or an app usually has a null emailAddress.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-result
 */
export const accessList = z
  .array(
    z.looseObject({
      graphId: z.string(),
      principalType: z.enum(["User", "Group", "App", "None"]),
      emailAddress: z.string().nullish(),
    }),
  )
  .transform((entries) =>
    entries.flatMap((entry): AccessEntry[] => {
      if (entry.principalType === "None") return [];
      const right = Object.entries(entry).find(
        ([key, value]) =>
          key.endsWith("UserAccessRight") && typeof value === "string",
      )?.[1];
      return [
        {
          principal_type: PRINCIPAL_TYPE[entry.principalType],
          principal_object_id: entry.graphId,
          email: entry.emailAddress ?? null,
          access_right: typeof right === "string" ? right : null,
        },
      ];
    }),
  );

const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  workspaceId: z.string(),
  publishedBy: z.string().optional(),
  lastUpdate: z.string().optional(),
});
const reportSchema = z.object({
  id: z.string(),
  name: z.string(),
  datasetId: z.string().optional(),
  appId: z.string().optional(),
  workspaceId: z.string().optional(),
});
export type PowerBiApp = z.output<typeof appSchema>;
export type PowerBiReport = z.output<typeof reportSchema>;

/** $top and $skip until a page comes back short. admin/apps refuses $skip=0, so the first page has none. */
async function readPages<T extends z.ZodType>(
  deps: PowerBiDeps,
  path: string,
  item: T,
  query: Record<string, string>,
  pageSize = PAGE_SIZE,
): Promise<z.output<T>[]> {
  const all: z.output<T>[] = [];
  const list = z.object({ value: z.array(item) });
  for (;;) {
    const page = new URLSearchParams({ ...query, $top: String(pageSize) });
    if (all.length > 0) page.set("$skip", String(all.length));
    const body = await requestAdmin(deps, `${path}?${page.toString()}`);
    const { value } = parseAnswer(list, body, ADMIN_API);
    all.push(...value);
    if (value.length < pageSize) return all;
  }
}

export function listApps(
  deps: PowerBiDeps,
  options: { page_size?: number } = {},
): Promise<PowerBiApp[]> {
  return readPages(deps, "/apps", appSchema, {}, options.page_size);
}

/** An audience's answer at all, whatever its entries hold: a gateway's page is not one. */
const audienceAnswer = z.object({ value: z.array(z.unknown()) });

/** An app's audience, read on every full sync. */
export async function appUsers(
  deps: PowerBiDeps,
  appId: string,
): Promise<AccessEntry[]> {
  const path = `/apps/${encodeURIComponent(appId)}/users`;
  const body = await requestAdmin(deps, path);
  parseAnswer(audienceAnswer, body, ADMIN_API);
  return parseAnswer(z.object({ value: accessList }), body, ADMIN_API, {
    audience_unreadable: true,
  }).value;
}

/**
 * Whether an audience's read failed for that app alone, so the next app's may
 * still be read: Power BI says it no longer knows the app, the answer passed
 * the limit, or it holds an entry this version cannot read. A refused or
 * unanswered request says nothing about the app, nor does a gateway's page,
 * whatever its status: Microsoft's own 404 carries an error code.
 */
export function mayBeOneApp(error: ServiceError): boolean {
  const { detail } = error;
  return (
    (detail.status === 404 && detail.code !== undefined) ||
    detail.too_large === true ||
    detail.audience_unreadable === true
  );
}

/** Reports across the tenant, or one app's: for an app whose reports the scan did not show. */
export function listReports(
  deps: PowerBiDeps,
  options: { app_id?: string; page_size?: number } = {},
): Promise<PowerBiReport[]> {
  const app = options.app_id?.replace(/'/g, "''");
  const query: Record<string, string> =
    app === undefined ? {} : { $filter: `appId eq '${app}'` };
  return readPages(deps, "/reports", reportSchema, query, options.page_size);
}

const workspaceSchema = z.object({
  id: z.guid(),
  name: z.string().transform((name) =>
    name
      .replaceAll("\u0000", "")
      .replace(/[\uD800-\uDFFF]/gu, "")
      .slice(0, 256)
      .replace(/[\uD800-\uDBFF]$/u, ""),
  ),
  type: z.string(),
});

export async function listWorkspaces(
  deps: PowerBiDeps,
  options: { top: number },
) {
  const query = new URLSearchParams({
    $top: String(options.top),
    $filter: "state eq 'Active'",
  });
  const body = await requestAdmin(deps, `/groups?${query.toString()}`);
  return parseAnswer(
    z.object({ value: z.array(workspaceSchema).max(options.top) }),
    body,
    ADMIN_API,
  ).value.map((workspace) => ({
    ...workspace,
    personal: !["Workspace", "Group"].includes(workspace.type),
  }));
}
