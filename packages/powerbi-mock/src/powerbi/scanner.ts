import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { readJsonObject, type MockState } from "../entra/context.js";
import type { Column, Dataset, Table, Workspace } from "../tenant.js";
import { accessUser } from "./access.js";
import { isRowNumber } from "./dax.js";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  refuseWhenThrottled,
  type Runtime,
  type Scan,
} from "./limits.js";
import { compact, flag, powerBiError } from "./wire.js";

/**
 * The scanner's limits, each Microsoft's: modified 30 requests an hour,
 * getInfo 500 an hour and 16 scans at once, scanStatus 10,000 an hour,
 * scanResult 500 an hour, and a result kept 24 hours.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-post-workspace-info
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-modified-workspaces
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-status
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-result
 */
const MODIFIED_PER_HOUR = 30;
const GET_INFO_PER_HOUR = 500;
const SCAN_STATUS_PER_HOUR = 10_000;
const SCAN_RESULT_PER_HOUR = 500;
const SCANS_AT_ONCE = 16;
const WORKSPACES_PER_SCAN = 100;
const MODIFIED_SINCE_MIN_AGE_MS = 30 * MINUTE_MS;
const MODIFIED_SINCE_MAX_AGE_MS = 30 * DAY_MS;
/**
 * Exactly as Microsoft's sample writes it, 2020-10-02T05:51:30.0000000Z: a real tenant answered 400 to three digits and to none.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-modified-workspaces
 */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

type ScanFlags = { schema: boolean; expressions: boolean; users: boolean };

/**
 * Microsoft's scanResult reference lists no columnType, but real scans
 * carry one and the mirror stores it. The hidden RowNumber-<guid> column
 * the engine adds to every table appears in Microsoft's sample.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-result
 */
function columnType(table: Table, column: Column): string {
  if (isRowNumber(column)) return "RowNumber";
  if (column.expression !== undefined) return "Calculated";
  if (table.source_expression !== undefined) return "CalculatedTableColumn";
  return "Data";
}

/** Invented M, so a sync that must drop the mashup has something to drop. */
function mashupFor(table_name: string): string {
  return `let\n Source = Sql.Database(SampleServer, "SampleDatabase"),\n Table = Source{[Schema="dbo",Item="${table_name}"]}[Data]\nin\n Table`;
}

const MASHUP_PARAMETER = {
  name: "SampleServer",
  description: "The server the sample tables load from",
  expression:
    '"sample-server.example.invalid" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]',
};

function datasetInfo(
  state: MockState,
  dataset: Dataset,
  flags: ScanFlags,
): Record<string, unknown> {
  const { settings } = state.tenant;
  const with_expressions = flags.expressions && settings.dax_expressions;
  const info: Record<string, unknown> = compact({
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    configuredBy: dataset.configured_by,
    targetStorageMode: dataset.storage_mode,
    isEffectiveIdentityRequired:
      dataset.has_row_level_security || dataset.effective_identity_required,
    isEffectiveIdentityRolesRequired: dataset.has_row_level_security,
  });
  if (flags.users) {
    info.users = dataset.users.map((entry) =>
      accessUser(state.tenant, entry, "datasetUserAccessRight"),
    );
  }
  if (with_expressions) info.expressions = [MASHUP_PARAMETER];
  // Microsoft's sample answer carries an empty relationships list on a
  // dataset; its schema does not define the field.
  info.relationships = [];
  if (!flags.schema) return info;

  if (dataset.schema_retrieval_error !== null) {
    info.schemaRetrievalError = dataset.schema_retrieval_error;
    return info;
  }
  info.tables = dataset.tables.map((table) => {
    const info_table: Record<string, unknown> = compact({
      name: table.name,
      description: table.description,
      isHidden: table.hidden,
    });
    if (settings.detailed_metadata) {
      info_table.columns = table.columns.map((column) =>
        compact({
          name: column.name,
          dataType: column.data_type,
          isHidden: column.hidden,
          columnType: columnType(table, column),
          expression: with_expressions ? column.expression : null,
        }),
      );
      info_table.measures = table.measures.map((measure) =>
        compact({
          name: measure.name,
          description: measure.description,
          formatString: measure.format_string,
          isHidden: measure.hidden,
          expression: with_expressions ? measure.expression : null,
        }),
      );
    }
    if (with_expressions)
      info_table.source = [{ expression: mashupFor(table.name) }];
    return info_table;
  });
  return info;
}

function workspaceInfo(
  state: MockState,
  workspace: Workspace,
  flags: ScanFlags,
): Record<string, unknown> {
  const { tenant } = state;
  const info: Record<string, unknown> = {
    id: workspace.id,
    name: workspace.name,
    type: workspace.type,
    state: workspace.state,
    isOnDedicatedCapacity: false,
    reports: tenant.reports
      .filter((report) => workspace.report_ids.includes(report.id))
      .map((report) =>
        compact({
          id: report.id,
          name: report.name,
          reportType: "PowerBIReport",
          datasetId: report.dataset_id,
          appId: report.app_id,
        }),
      ),
    dashboards: [],
    datasets: tenant.datasets
      .filter((dataset) => workspace.dataset_ids.includes(dataset.id))
      .map((dataset) => datasetInfo(state, dataset, flags)),
    dataflows: [],
    datamarts: [],
  };
  if (flags.users) {
    info.users = workspace.users_unlisted
      ? null
      : workspace.users.map((entry) =>
          accessUser(tenant, entry, "groupUserAccessRight"),
        );
  }
  return info;
}

function scanBody(scan: Scan, status: string) {
  return {
    id: scan.id,
    createdDateTime: new Date(scan.created_at).toISOString(),
    status,
    ...(status === "Failed"
      ? { error: { code: "ScanFailed", message: scan.failure } }
      : {}),
  };
}

function scanStatus(scan: Scan): "Running" | "Succeeded" | "Failed" {
  if (scan.polls <= 1) return "Running";
  return scan.failure === null ? "Succeeded" : "Failed";
}

/**
 * The scanner flow of the Admin APIs, under /v1.0/myorg/admin. The caller
 * has been authenticated as an allowed service principal by the time a
 * route here runs.
 */
export function scannerRoutes(state: MockState, runtime: Runtime): Hono {
  const app = new Hono();

  /** A scan is gone 24 hours after it began, by mock time. */
  function forgetOldScans(): void {
    for (const [id, scan] of runtime.scans) {
      if (Date.now() - scan.created_at >= DAY_MS) runtime.scans.delete(id);
    }
  }

  app.get("/workspaces/modified", (c) => {
    const throttled = refuseWhenThrottled(c, runtime, {
      bucket: "admin:modified",
      max: MODIFIED_PER_HOUR,
      window_ms: HOUR_MS,
    });
    if (throttled) return throttled;

    const raw_since = c.req.query("modifiedSince");
    let since: number | undefined;
    if (raw_since !== undefined) {
      since = Date.parse(raw_since);
      const age = Date.now() - since;
      if (
        !UTC_DATE_TIME.test(raw_since) ||
        Number.isNaN(age) ||
        age < MODIFIED_SINCE_MIN_AGE_MS ||
        age > MODIFIED_SINCE_MAX_AGE_MS
      ) {
        return powerBiError(
          c,
          400,
          "InvalidRequest",
          "modifiedSince must be an ISO 8601 UTC date-time with seven fractional digits ending in Z, between 30 minutes and 30 days before now.",
        );
      }
    }
    // excludeInActiveWorkspaces is read and ignored: Microsoft does not say
    // what makes a workspace inactive, and the tenant has no activity data.
    const exclude_personal = flag(c.req.query("excludePersonalWorkspaces"));
    const modified_after = (w: Workspace) =>
      since === undefined ||
      (w.modified_at === undefined ? Date.now() : Date.parse(w.modified_at)) >
        since;
    return c.json(
      state.tenant.workspaces
        .filter((w) => !exclude_personal || w.type !== "PersonalGroup")
        .filter(modified_after)
        .map((w) => ({ id: w.id })),
    );
  });

  app.post("/workspaces/getInfo", async (c) => {
    forgetOldScans();
    const throttled = refuseWhenThrottled(c, runtime, {
      bucket: "admin:getInfo",
      max: GET_INFO_PER_HOUR,
      window_ms: HOUR_MS,
    });
    if (throttled) return throttled;
    const running = [...runtime.scans.values()].filter(
      (scan) => scanStatus(scan) === "Running",
    );
    if (running.length >= SCANS_AT_ONCE) {
      c.header("Retry-After", "30");
      return powerBiError(
        c,
        429,
        "TooManyRequests",
        `At most ${String(SCANS_AT_ONCE)} scans may run at once.`,
      );
    }

    const body = await readJsonObject(c);
    const ids = body?.workspaces;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > WORKSPACES_PER_SCAN ||
      !ids.every((id) => typeof id === "string")
    ) {
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "workspaces must list 1 to 100 workspace ids.",
      );
    }
    const flags: ScanFlags = {
      schema: flag(c.req.query("datasetSchema")),
      expressions: flag(c.req.query("datasetExpressions")),
      users: flag(c.req.query("getArtifactUsers")),
    };
    // Workspaces the tenant does not have are left out of the result.
    const workspaces = state.tenant.workspaces.filter((w) =>
      ids.includes(w.id),
    );
    const scan: Scan = {
      id: randomUUID(),
      created_at: Date.now(),
      polls: 0,
      failure: workspaces.find((w) => w.scan_failure)?.scan_failure ?? null,
      result: {
        workspaces: workspaces.map((w) => workspaceInfo(state, w, flags)),
      },
    };
    runtime.scans.set(scan.id, scan);
    return c.json(scanBody(scan, "NotStarted"), 202);
  });

  app.get("/workspaces/scanStatus/:scan_id", (c) => {
    forgetOldScans();
    const throttled = refuseWhenThrottled(c, runtime, {
      bucket: "admin:scanStatus",
      max: SCAN_STATUS_PER_HOUR,
      window_ms: HOUR_MS,
    });
    if (throttled) return throttled;
    const scan = runtime.scans.get(c.req.param("scan_id"));
    if (!scan) {
      return powerBiError(c, 404, "PowerBIEntityNotFound", "Scan not found.");
    }
    scan.polls += 1;
    return c.json(scanBody(scan, scanStatus(scan)));
  });

  app.get("/workspaces/scanResult/:scan_id", (c) => {
    forgetOldScans();
    const throttled = refuseWhenThrottled(c, runtime, {
      bucket: "admin:scanResult",
      max: SCAN_RESULT_PER_HOUR,
      window_ms: HOUR_MS,
    });
    if (throttled) return throttled;
    const scan = runtime.scans.get(c.req.param("scan_id"));
    if (!scan) {
      return powerBiError(c, 404, "PowerBIEntityNotFound", "Scan not found.");
    }
    // Microsoft: call this "only after a successful GetScanStatus call".
    if (scanStatus(scan) !== "Succeeded") {
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "The scan has not succeeded yet; poll scanStatus first.",
      );
    }
    return c.json(scan.result);
  });

  return app;
}
