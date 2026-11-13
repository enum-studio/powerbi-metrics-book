import { defaultTenantSettings, type Tenant } from "./tenant.js";

export const TEST_TENANT_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_REDIRECT_URI =
  "http://localhost:3000/api/v1/powerbi/callback";

/** Fresh on every call, so a test that patches its tenant never leaks into another. */
export function createTestTenant(): Tenant {
  const workspace_id = "aaaaaaaa-0000-4000-8000-000000000001";
  const dataset_id = "dddddddd-0000-4000-8000-000000000001";
  const report_id = "eeeeeeee-0000-4000-8000-000000000001";
  const app_id = "bbbbbbbb-0000-4000-8000-000000000001";
  return {
    tenant_id: TEST_TENANT_ID,
    people: [
      {
        object_id: "cccccccc-0000-4000-8000-000000000001",
        email: "ada@example.test",
        user_principal_name: "ada@example.test",
        name: "Ada Example",
        group_ids: [
          "99999999-0000-4000-8000-000000000001",
          "99999999-0000-4000-8000-000000000002",
          "99999999-0000-4000-8000-000000000003",
        ],
        revoked: false,
      },
      {
        object_id: "cccccccc-0000-4000-8000-000000000002",
        email: "grace@example.test",
        user_principal_name: "grace@example.test",
        name: "Grace Example",
        group_ids: [],
        revoked: true,
      },
    ],
    groups: [
      {
        object_id: "99999999-0000-4000-8000-000000000001",
        name: "Analysts",
      },
      {
        object_id: "99999999-0000-4000-8000-000000000002",
        name: "Finance",
      },
      {
        object_id: "99999999-0000-4000-8000-000000000003",
        name: "Everyone",
      },
    ],
    service_principals: [
      {
        app_id: "77777777-0000-4000-8000-000000000001",
        object_id: "77777777-0000-4000-8000-0000000000a1",
        secret: "scanner-secret",
        may_call_admin_apis: true,
      },
    ],
    apps_registrations: [
      {
        client_id: "66666666-0000-4000-8000-000000000001",
        secret: "web-secret",
        redirect_uris: [TEST_REDIRECT_URI],
        kind: "confidential_web",
      },
    ],
    settings: defaultTenantSettings(),
    workspaces: [
      {
        id: workspace_id,
        name: "Sales",
        type: "Workspace",
        state: "Active",
        users: [
          // Contributor, not Viewer: the role that gives Ada Build (to query)
          // and write (to read measures' DAX) on the workspace's datasets.
          {
            principal_type: "Group",
            object_id: "99999999-0000-4000-8000-000000000001",
            access_right: "Contributor",
          },
        ],
        dataset_ids: [dataset_id],
        report_ids: [report_id],
      },
    ],
    apps: [
      {
        id: app_id,
        name: "Sales app",
        description: "The sales report, published.",
        workspace_id,
        published_by: "ada@example.test",
        last_update: "2026-10-01T00:00:00Z",
        users: [
          {
            principal_type: "User",
            object_id: "cccccccc-0000-4000-8000-000000000001",
            access_right: "Read",
          },
        ],
        report_ids: [report_id],
      },
    ],
    reports: [
      {
        id: report_id,
        name: "Sales overview",
        dataset_id,
        app_id,
      },
    ],
    datasets: [
      {
        id: dataset_id,
        workspace_id,
        name: "Sales model",
        description: null,
        configured_by: "ada@example.test",
        storage_mode: "Import",
        has_row_level_security: false,
        schema_retrieval_error: null,
        tables: [
          {
            name: "Orders",
            description: null,
            hidden: false,
            columns: [
              {
                name: "OrderId",
                data_type: "Int64",
                description: null,
                hidden: false,
              },
              {
                name: "Amount",
                data_type: "Double",
                description: null,
                hidden: false,
              },
            ],
            measures: [
              {
                name: "Total sales",
                expression: "SUM(Orders[Amount])",
                description: null,
                format_string: "#,0",
                hidden: false,
                display_folder: null,
              },
            ],
            rows: [
              { OrderId: 1, Amount: 10.5 },
              { OrderId: 2, Amount: 20 },
            ],
          },
        ],
        relationships: [],
        users: [],
        recorded_queries: [],
      },
    ],
  };
}
