import type {
  Principal as CerbosPrincipal,
  Resource as CerbosResource,
  Value,
} from "@cerbos/core";
import { HTTP } from "@cerbos/http";
import { sql, type SQL } from "drizzle-orm";
import type { Access, Resource, SettingsStore } from "../../context.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import {
  anyOf,
  planCondition,
  queryLogPlanCondition,
  requestPlanCondition,
  searchLogPlanCondition,
  shownByApps,
} from "./plan.js";

/**
 * Every question is asked at this scope. A deployment's own policies sit
 * there; Cerbos's lenient scope search falls back to the defaults at the
 * root scope for a resource the deployment wrote none for.
 */
const SCOPE = "deployment";

/**
 * Access decided by Cerbos (access/policies, and a deployment's own layered
 * on them). Every principal is sent with its kind and the metadata
 * visibility mode, read from settings on each call, so a change in the admin
 * section applies at once.
 *
 * A service account reaches only datasets in the workspaces and apps its
 * admin gave it. That bound is code, not policy: a deployment policy in
 * override mode decides ahead of every rule at the root scope, so no root
 * rule could stop one from widening a service account's reach. Nor may a
 * service account administer or change the conventions, whatever role a
 * policy grants it: a leaked key could otherwise widen itself. It may at
 * most read the admin status, when a policy gives its role that action. Nor
 * may one read PII, even holding pii_reader.
 *
 * PII is read by a person holding pii_reader and by no one else, whatever a
 * deployment's policy grants: it can only narrow that.
 *
 * Ordinary dataset reads exclude off datasets in code, regardless of policy.
 * Admin review uses reachableDatasets to include off datasets within reach.
 */
export function createAccess(options: {
  cerbosUrl: URL;
  settings: SettingsStore;
}): Access {
  // The client appends /api/... to the URL as written.
  const cerbos = new HTTP(options.cerbosUrl.href.replace(/\/$/, ""));

  async function asCerbos(principal: Principal): Promise<CerbosPrincipal> {
    return {
      id: principal.id,
      roles: principal.roles,
      attr: {
        ...principal.attributes,
        ...listsOf(principal),
        kind: principal.kind,
        metadata_visibility: await options.settings.get(
          "access.metadata_visibility",
        ),
      },
    };
  }

  function resourceOf(resource: Resource): CerbosResource {
    // Sent as JSON, which is all a Cerbos attribute can hold; the callers
    // build attributes from database rows.
    return {
      kind: resource.kind,
      id: resource.id,
      attr: resource.attr as Record<string, Value>,
      scope: SCOPE,
    };
  }

  async function check(
    principal: Principal,
    resource: Resource,
    action: string,
  ): Promise<boolean> {
    // Before the principal's lists are read: an off dataset is refused to everyone.
    if (resource.kind === "dataset" && !isEnabled(resource)) return false;
    // A floor no policy can lower: a deployment's own may narrow pii, never widen it.
    if (
      resource.kind === "pii" &&
      !(principal.kind === "person" && principal.roles.includes("pii_reader"))
    )
      return false;
    const asked = await asCerbos(principal);
    if (
      principal.kind === "service_account" &&
      (beyondServiceAccounts(resource, action) ||
        (resource.kind === "dataset" &&
          !grantCovers(listsOf(principal), resource)))
    )
      return false;
    return cerbos.isAllowed({
      principal: asked,
      resource: resourceOf(resource),
      action,
    });
  }

  async function reachableDatasets(principal: Principal): Promise<SQL> {
    const plan = await cerbos.planResources({
      principal: await asCerbos(principal),
      resource: { kind: "dataset", scope: SCOPE },
      action: "describe",
    });
    const condition = planCondition(plan);
    if (principal.kind !== "service_account") return condition;
    return sql`(${grantCondition(listsOf(principal))} and ${condition})`;
  }

  return {
    check,
    async require(principal, resource, action) {
      if (await check(principal, resource, action)) return;
      // A dataset the caller may not see answers exactly like a missing one.
      if (resource.kind === "dataset")
        throw new ServiceError("not_found", NO_SUCH_DATASET);
      throw new ServiceError(
        "refused",
        `You may not ${action} this ${resource.kind}.`,
      );
    },
    reachableDatasets,
    async describableDatasets(principal) {
      const reachable = await reachableDatasets(principal);
      return sql`(${reachable} and ${powerbiDataset.enabled})`;
    },
    async readableQueryLog(principal) {
      const plan = await cerbos.planResources({
        principal: await asCerbos(principal),
        resource: { kind: "query_log", scope: SCOPE },
        action: "read",
      });
      return queryLogPlanCondition(plan);
    },
    async readableRequests(principal) {
      const plan = await cerbos.planResources({
        principal: await asCerbos(principal),
        resource: { kind: "request", scope: SCOPE },
        action: "read",
      });
      return requestPlanCondition(plan);
    },
    async readableSearchLog(principal) {
      const plan = await cerbos.planResources({
        principal: await asCerbos(principal),
        resource: { kind: "search_log", scope: SCOPE },
        action: "read",
      });
      return searchLogPlanCondition(plan);
    },
  };
}

type Lists = {
  powerbi_workspace_ids: string[];
  powerbi_app_ids: string[];
  powerbi_dataset_ids: string[];
};

/**
 * The principal's three lists, empty when it reaches nothing. A missing one
 * is a bug in whoever built the principal: read as empty it would pass for
 * no access, or for a service account no grant, so it throws.
 */
function listsOf(principal: Principal): Lists {
  const list = (name: keyof Lists): string[] => {
    const value = principal.attributes[name];
    if (value === undefined)
      throw new Error(
        `access: ${principal.kind} ${principal.id} has no ${name}; every principal carries all three Power BI lists`,
      );
    return value;
  };
  return {
    powerbi_workspace_ids: list("powerbi_workspace_ids"),
    powerbi_app_ids: list("powerbi_app_ids"),
    powerbi_dataset_ids: list("powerbi_dataset_ids"),
  };
}

/**
 * What no service account may do: anything in the admin section but read
 * its status, which holds no secret and lets `pbmb admin status` check a
 * deployment read-only; or edit the conventions. PII is refused to a service
 * account by the floor in check.
 */
function beyondServiceAccounts(resource: Resource, action: string): boolean {
  return (
    (resource.kind === "admin" && action !== "read_status") ||
    (resource.kind === "book" && action === "edit_conventions")
  );
}

/**
 * Whether a dataset resource is on. One without a boolean `enabled` is a bug
 * in whoever built it: read as on it would show an off dataset, so it throws.
 */
function isEnabled(dataset: Resource): boolean {
  const { enabled } = dataset.attr;
  if (typeof enabled !== "boolean")
    throw new Error(
      `access: dataset ${dataset.id} has no boolean enabled; every dataset resource carries it`,
    );
  return enabled;
}

/** Whether a service account's grant (its workspaces and apps) covers the dataset. */
function grantCovers(grant: Lists, dataset: Resource): boolean {
  const { workspace_id, app_ids } = dataset.attr;
  return (
    (typeof workspace_id === "string" &&
      grant.powerbi_workspace_ids.includes(workspace_id)) ||
    (Array.isArray(app_ids) &&
      app_ids.some(
        (id) => typeof id === "string" && grant.powerbi_app_ids.includes(id),
      ))
  );
}

function grantCondition(grant: Lists): SQL {
  return sql`(${anyOf(powerbiDataset.workspace_id, grant.powerbi_workspace_ids)} or ${shownByApps(grant.powerbi_app_ids)})`;
}
