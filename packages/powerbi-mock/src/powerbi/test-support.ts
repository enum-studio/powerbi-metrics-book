import { POWER_BI_AUDIENCE, signToken } from "../entra/tokens.js";
import { buildMock } from "../server.js";
import { createTestTenant } from "../test-tenant.js";
import type { AccessEntry, Dataset, Table, Tenant } from "../tenant.js";

export const ADA = "cccccccc-0000-4000-8000-000000000001";
export const BEN = "cccccccc-0000-4000-8000-000000000003";
export const CLEO = "cccccccc-0000-4000-8000-000000000004";
export const DAN = "cccccccc-0000-4000-8000-000000000005";
export const EVE = "cccccccc-0000-4000-8000-000000000006";
export const FAY = "cccccccc-0000-4000-8000-000000000007";
export const GIL = "cccccccc-0000-4000-8000-000000000008";
export const SCANNER_APP_ID = "77777777-0000-4000-8000-000000000001";
export const MEMBER_APP_ID = "77777777-0000-4000-8000-000000000002";
export const WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const DATASET_ID = "dddddddd-0000-4000-8000-000000000001";
export const RLS_DATASET_ID = "dddddddd-0000-4000-8000-000000000002";
export const BROKEN_DATASET_ID = "dddddddd-0000-4000-8000-000000000003";
export const APP_ID = "bbbbbbbb-0000-4000-8000-000000000001";
export const PERSONAL_WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000002";
export const DELETED_WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000003";

const ORIGIN = "http://mock.test";
export const API = `${ORIGIN}/powerbi/v1.0/myorg`;

function person(object_id: string, name: string, group_ids: string[] = []) {
  const email = `${name.toLowerCase()}@example.test`;
  return {
    object_id,
    email,
    user_principal_name: email,
    name,
    group_ids,
    revoked: false,
  };
}

/** A table whose every cell in row n holds `cell(n)`, the row's index unless told otherwise. */
export function table(
  name: string,
  columns: string[],
  rows: number,
  cell: (row: number) => unknown = (row) => row,
): Table {
  return {
    name,
    description: null,
    hidden: false,
    columns: columns.map((column) => ({
      name: column,
      data_type: "Int64",
      description: null,
      hidden: false,
    })),
    measures: [],
    rows: Array.from({ length: rows }, (_, index) =>
      Object.fromEntries(columns.map((column) => [column, cell(index)])),
    ),
  };
}

function datasetLike(base: Dataset, id: string, name: string): Dataset {
  return { ...structuredClone(base), id, name };
}

/**
 * The core's test tenant plus the people and datasets the Power BI routes
 * need: Ada is a workspace Contributor through a group, Ben reaches the
 * sales dataset only through the app with Build (ReadExplore), Gil through
 * the app without it (Read), Dan by a direct share with Build, Eve by a
 * share without it, Fay as a workspace Viewer, Cleo not at all, and a
 * second service principal is a workspace Member.
 */
export function powerBiTenant(): Tenant {
  const tenant = createTestTenant();
  const [workspace] = tenant.workspaces;
  const [app] = tenant.apps;
  const [sales] = tenant.datasets;
  const [orders] = sales?.tables ?? [];
  const [total_sales] = orders?.measures ?? [];
  if (!workspace || !app || !sales || !orders || !total_sales)
    throw new Error("test tenant");

  tenant.people.push(
    person(BEN, "Ben"),
    person(CLEO, "Cleo"),
    person(DAN, "Dan"),
    person(EVE, "Eve"),
    person(FAY, "Fay"),
    person(GIL, "Gil"),
  );
  const user = (object_id: string, access_right: string): AccessEntry => ({
    principal_type: "User",
    object_id,
    access_right,
  });
  app.users.push(user(BEN, "ReadExplore"), user(GIL, "Read"));
  sales.users.push(user(DAN, "ReadExplore"), user(EVE, "Read"));
  workspace.users.push(user(FAY, "Viewer"));
  total_sales.display_folder = "Revenue";
  sales.relationships.push({
    from_table: "Orders",
    from_column: "OrderId",
    to_table: "Customers",
    to_column: "CustomerId",
    from_cardinality: "Many",
    to_cardinality: "One",
    cross_filtering_behavior: "OneDirection",
    is_active: true,
  });
  sales.tables.push(table("Customers", ["CustomerId"], 3));
  sales.tables[0]?.columns.push({
    name: "RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61",
    data_type: "Int64",
    description: null,
    hidden: true,
  });
  sales.recorded_queries.push({
    dax: 'EVALUATE SUMMARIZECOLUMNS(Orders[OrderId], "Sales", [Total sales])',
    rows: [{ "Orders[OrderId]": 1, "[Sales]": 10.5, "[Margin]": null }],
  });

  tenant.service_principals.push({
    app_id: MEMBER_APP_ID,
    object_id: "77777777-0000-4000-8000-0000000000a2",
    secret: "member-secret",
    may_call_admin_apis: false,
  });
  workspace.users.push({
    principal_type: "App",
    object_id: "77777777-0000-4000-8000-0000000000a2",
    access_right: "Member",
  });

  const rls = datasetLike(sales, RLS_DATASET_ID, "RLS model");
  rls.has_row_level_security = true;
  const broken = datasetLike(sales, BROKEN_DATASET_ID, "Unread model");
  broken.schema_retrieval_error = "The model has never been refreshed.";
  tenant.datasets.push(rls, broken);
  workspace.dataset_ids.push(RLS_DATASET_ID, BROKEN_DATASET_ID);

  tenant.workspaces.push(
    {
      id: PERSONAL_WORKSPACE_ID,
      name: "Personal",
      type: "PersonalGroup",
      state: "Active",
      users: [],
      dataset_ids: [],
      report_ids: [],
    },
    {
      id: DELETED_WORKSPACE_ID,
      name: "Deleted",
      type: "Workspace",
      state: "Deleted",
      users: [],
      dataset_ids: [],
      report_ids: [],
    },
  );
  return tenant;
}

export function startPowerBi(tenant: Tenant = powerBiTenant()) {
  const { app, state } = buildMock({ tenant, origin: ORIGIN, control: true });
  const issuer = `${ORIGIN}/${tenant.tenant_id}/v2.0`;

  const personToken = (oid: string, scp = "Dataset.Read.All") =>
    signToken(state, issuer, POWER_BI_AUDIENCE, { oid, sub: oid, scp });
  const principalToken = (app_id: string) => {
    const principal = tenant.service_principals.find(
      (candidate) => candidate.app_id === app_id,
    );
    if (!principal) throw new Error(`no service principal ${app_id}`);
    return signToken(state, issuer, POWER_BI_AUDIENCE, {
      oid: principal.object_id,
      sub: principal.object_id,
      appid: app_id,
      idtyp: "app",
    });
  };
  const call = (
    path: string,
    token: string | null,
    init: { method?: string; body?: unknown } = {},
  ) =>
    app.request(`${API}/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  /** The control route a test or the end-to-end run changes the tenant's settings through. */
  const patchSettings = (body: unknown) =>
    app.request(`${ORIGIN}/_mock/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    app,
    state,
    tenant,
    personToken,
    principalToken,
    call,
    patchSettings,
  };
}

/**
 * Makes `limit` calls, then one more: the distinct statuses of the first
 * `limit` (only 200 while the limit holds) and the answer past it.
 */
export async function pastLimit(
  limit: number,
  ask: () => Response | Promise<Response>,
): Promise<{ statuses: number[]; refused: Response }> {
  const statuses = new Set<number>();
  for (let call = 0; call < limit; call += 1) {
    statuses.add((await ask()).status);
  }
  return { statuses: [...statuses], refused: await ask() };
}
