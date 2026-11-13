import { Hono, type Context } from "hono";
import { originOf, type MockState } from "../entra/context.js";
import { accessUser } from "./access.js";
import {
  HOUR_MS,
  MINUTE_MS,
  refuseWhenThrottled,
  type Runtime,
} from "./limits.js";
import { powerBiError } from "./wire.js";

/**
 * Microsoft's limits: admin/apps and admin/apps/{id}/users 200 requests an
 * hour, admin/reports 50 an hour or 5 a minute per tenant.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/apps-get-apps-as-admin
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/apps-get-app-users-as-admin
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/reports-get-reports-as-admin
 */
const APPS_PER_HOUR = 200;
const REPORTS_PER_HOUR = 50;
const REPORTS_PER_MINUTE = 5;

function nonNegativeInteger(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * $top and $skip as Microsoft documents them; null when one is malformed.
 * admin/apps requires $top and gives both "minimum: 1", so $skip=0 is
 * refused there.
 */
function paging(
  c: Context,
  rules: { top_required: boolean; min_skip: number },
): { top: number | undefined; skip: number } | null {
  const raw_top = c.req.query("$top");
  const raw_skip = c.req.query("$skip");
  const top = raw_top === undefined ? undefined : nonNegativeInteger(raw_top);
  const skip = raw_skip === undefined ? 0 : nonNegativeInteger(raw_skip);
  if (top === null || skip === null || top === 0) return null;
  if (raw_skip !== undefined && skip < rules.min_skip) return null;
  if (rules.top_required && top === undefined) return null;
  return { top, skip };
}

/** The one $filter the mock evaluates on admin/reports: appId eq '<id>'. */
const APP_FILTER = /^\s*appId\s+eq\s+'([^']*)'\s*$/i;

/** The OData envelope the admin lists answer in. */
function odata(
  state: MockState,
  c: Context,
  context: string,
  value: unknown[],
) {
  return {
    "@odata.context": `${originOf(state, c)}/powerbi/v1.0/myorg/admin/$metadata#${context}`,
    value,
  };
}

/** Apps, their audiences and reports, under /v1.0/myorg/admin. */
export function adminRoutes(state: MockState, runtime: Runtime): Hono {
  const app = new Hono();
  const apps_limit = (bucket: string) => ({
    bucket,
    max: APPS_PER_HOUR,
    window_ms: HOUR_MS,
  });

  // https://learn.microsoft.com/en-us/rest/api/power-bi/admin/groups-get-groups-as-admin
  app.get("/groups", (c) => {
    const throttled = refuseWhenThrottled(
      c,
      runtime,
      { bucket: "admin:groups", max: 50, window_ms: HOUR_MS },
      { bucket: "admin:groups:minute", max: 15, window_ms: MINUTE_MS },
    );
    if (throttled) return throttled;
    const page = paging(c, { top_required: true, min_skip: 0 });
    const filter = c.req.query("$filter");
    if (
      !page ||
      page.top === undefined ||
      page.top > 5000 ||
      (filter !== undefined && filter !== "state eq 'Active'")
    )
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "Use $top from 1 to 5000, a nonnegative $skip and a supported $filter.",
      );
    const groups = state.tenant.workspaces
      .filter((w) => filter === undefined || w.state === "Active")
      .slice(page.skip, page.skip + page.top)
      .map(({ id, name, type, state }) => ({ id, name, type, state }));
    return c.json(odata(state, c, "groups", groups));
  });

  app.get("/apps", (c) => {
    const throttled = refuseWhenThrottled(c, runtime, apps_limit("admin:apps"));
    if (throttled) return throttled;
    const page = paging(c, { top_required: true, min_skip: 1 });
    if (!page) {
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "$top is required and must be 1 or more; $skip, when given, must be 1 or more.",
      );
    }
    const apps = state.tenant.apps
      .slice(
        page.skip,
        page.top === undefined ? undefined : page.skip + page.top,
      )
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        lastUpdate: a.last_update,
        publishedBy: a.published_by,
        workspaceId: a.workspace_id,
      }));
    return c.json(odata(state, c, "apps", apps));
  });

  app.get("/apps/:app_id/users", (c) => {
    const throttled = refuseWhenThrottled(
      c,
      runtime,
      apps_limit("admin:appUsers"),
    );
    if (throttled) return throttled;
    const found = state.tenant.apps.find((a) => a.id === c.req.param("app_id"));
    if (!found) {
      return powerBiError(c, 404, "PowerBIEntityNotFound", "App not found.");
    }
    const users = found.users.map((entry) =>
      accessUser(state.tenant, entry, "appUserAccessRight"),
    );
    return c.json(odata(state, c, "users", users));
  });

  app.get("/reports", (c) => {
    const throttled = refuseWhenThrottled(
      c,
      runtime,
      { bucket: "admin:reports", max: REPORTS_PER_HOUR, window_ms: HOUR_MS },
      {
        bucket: "admin:reports:minute",
        max: REPORTS_PER_MINUTE,
        window_ms: MINUTE_MS,
      },
    );
    if (throttled) return throttled;
    const filter = c.req.query("$filter");
    const app_filter = filter === undefined ? null : APP_FILTER.exec(filter);
    if (filter !== undefined && !app_filter) {
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "The mock evaluates only the $filter appId eq '<app id>'.",
      );
    }
    const page = paging(c, { top_required: false, min_skip: 0 });
    if (!page) {
      return powerBiError(
        c,
        400,
        "InvalidRequest",
        "$top must be 1 or more; $skip must be 0 or more.",
      );
    }
    const reports = state.tenant.reports
      .filter((report) => !app_filter || report.app_id === app_filter[1])
      .slice(
        page.skip,
        page.top === undefined ? undefined : page.skip + page.top,
      )
      .map((report) => {
        const workspace = state.tenant.workspaces.find((w) =>
          w.report_ids.includes(report.id),
        );
        return {
          id: report.id,
          name: report.name,
          reportType: "PowerBIReport",
          datasetId: report.dataset_id,
          ...(report.app_id === null ? {} : { appId: report.app_id }),
          ...(workspace ? { workspaceId: workspace.id } : {}),
        };
      });
    return c.json(odata(state, c, "reports", reports));
  });

  return app;
}
