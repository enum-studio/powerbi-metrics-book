import type { AccessEntry, Dataset, Person, Tenant } from "../tenant.js";
import type { Caller } from "./caller.js";

/**
 * One line of an access list as the admin APIs write it. A group or an app
 * usually has no email address and no user type, which Power BI answers as
 * null, not leaves out. The access right's key differs by item:
 * groupUserAccessRight on a workspace, datasetUserAccessRight on a dataset,
 * appUserAccessRight on an app.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-result
 */
export function accessUser(
  tenant: Tenant,
  entry: AccessEntry,
  right_key: string,
): Record<string, unknown> {
  const person = tenant.people.find((p) => p.object_id === entry.object_id);
  const group = tenant.groups.find((g) => g.object_id === entry.object_id);
  const email = entry.email ?? person?.email;
  return {
    displayName: person?.name ?? group?.name ?? email ?? entry.object_id,
    ...(entry.principal_type === "User"
      ? email === undefined
        ? {}
        : { emailAddress: email }
      : { emailAddress: email ?? null, userType: null }),
    identifier:
      entry.principal_type === "User"
        ? (email ?? entry.object_id)
        : entry.object_id,
    graphId: entry.object_id,
    principalType: entry.principal_type,
    [right_key]: entry.access_right,
  };
}

function namesPerson(entry: AccessEntry, person: Person): boolean {
  return (
    (entry.principal_type === "User" && entry.object_id === person.object_id) ||
    (entry.principal_type === "Group" &&
      person.group_ids.includes(entry.object_id))
  );
}

/**
 * A service principal is listed by its object id, the graphId of the admin
 * APIs' access lists, never by its application id.
 */
function namesCaller(entry: AccessEntry, caller: Caller): boolean {
  if (entry.access_right === "None") return false;
  if (caller.kind === "person") return namesPerson(entry, caller.person);
  return (
    entry.principal_type === "App" &&
    entry.object_id === caller.principal.object_id
  );
}

/**
 * The workspace roles that hold Build and write on every dataset in the
 * workspace; a Viewer holds neither.
 * https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-build-permissions
 * https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-roles-new-workspaces
 */
const BUILDING_ROLES = ["Admin", "Member", "Contributor"];

/** Whether the caller's role in the dataset's workspace lets it write to the dataset. */
export function mayWrite(
  tenant: Tenant,
  caller: Caller,
  dataset: Dataset,
): boolean {
  const workspace = tenant.workspaces.find(
    (w) => w.id === dataset.workspace_id,
  );
  return (
    workspace?.users.some(
      (entry) =>
        namesCaller(entry, caller) &&
        BUILDING_ROLES.includes(entry.access_right),
    ) ?? false
  );
}

function appShowsDataset(tenant: Tenant, app_id: string, dataset_id: string) {
  const app = tenant.apps.find((candidate) => candidate.id === app_id);
  return tenant.reports.some(
    (report) =>
      report.dataset_id === dataset_id &&
      (report.app_id === app_id || app?.report_ids.includes(report.id)),
  );
}

/**
 * Whether Power BI lets the caller query the dataset: the caller needs
 * Read and Build ("The user must have dataset read and build permissions").
 * Build comes from an Admin, Member or Contributor workspace role, or from
 * a direct share or an app audience whose right carries Explore (Build is
 * Explore on the wire; an app's audience gets it when the publisher allows
 * building content, on the datasets behind the app's reports). Only a
 * workspace member may use the /groups/{id} path. A service principal holds
 * Build only by its workspace role.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries
 * https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-build-permissions
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-get-scan-result (DatasetUserAccessRight)
 */
export function mayQuery(
  tenant: Tenant,
  caller: Caller,
  dataset: Dataset,
  by_workspace_path: boolean,
): boolean {
  const workspace = tenant.workspaces.find(
    (w) => w.id === dataset.workspace_id,
  );
  const member =
    workspace?.users.some((entry) => namesCaller(entry, caller)) ?? false;
  if (by_workspace_path && !member) return false;
  if (mayWrite(tenant, caller, dataset)) return true;
  if (caller.kind === "service_principal") return false;
  const grantsBuild = (entry: AccessEntry) =>
    namesCaller(entry, caller) && entry.access_right.endsWith("Explore");
  return (
    dataset.users.some(grantsBuild) ||
    tenant.apps.some(
      (app) =>
        app.users.some(grantsBuild) &&
        appShowsDataset(tenant, app.id, dataset.id),
    )
  );
}
