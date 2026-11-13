/**
 * The tenant every route of the mock reads. Plain data: a test builds one
 * literal, the sample tenant is another, and nothing here runs.
 */

/** One line of a workspace's, an app's or a dataset's access list, as Power BI's admin APIs list it. */
export type AccessEntry = {
  principal_type: "User" | "Group" | "App";
  object_id: string;
  email?: string;
  access_right: string;
};

export type Person = {
  object_id: string;
  email: string;
  user_principal_name: string;
  guest?: boolean;
  home_address?: string;
  name: string;
  /** Every group the person belongs to, nested ones included, as Graph's transitiveMemberOf lists them. */
  group_ids: string[];
  /** Consent withdrawn: authorize answers consent_required and refresh tokens answer invalid_grant. */
  revoked: boolean;
};

export type Group = { object_id: string; name: string };

export type ServicePrincipal = {
  app_id: string;
  object_id: string;
  secret: string;
  may_call_admin_apis: boolean;
};

export type AppRegistration = {
  client_id: string;
  secret: string;
  redirect_uris: string[];
  kind: "confidential_web";
  email_optional_claim?: boolean;
};

export type TenantSettings = {
  detailed_metadata: boolean;
  dax_expressions: boolean;
  execute_queries: boolean;
  service_principals_admin_apis: boolean;
};

export type Column = {
  name: string;
  data_type: string;
  description: string | null;
  hidden: boolean;
  /** A calculated column's DAX; the scanner then reports `columnType: "Calculated"`. */
  expression?: string;
  /** The folder the column is filed in, nested with a backslash; absent is none. */
  display_folder?: string | null;
};

export type Measure = {
  name: string;
  expression: string;
  description: string | null;
  format_string: string | null;
  hidden: boolean;
  display_folder: string | null;
};

export type Table = {
  name: string;
  description: string | null;
  hidden: boolean;
  /** A calculated table's DAX; its columns are then `CalculatedTableColumn`. */
  source_expression?: string;
  columns: Column[];
  measures: Measure[];
  rows: Record<string, unknown>[];
};

export type Relationship = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  from_cardinality: "One" | "Many";
  to_cardinality: "One" | "Many";
  cross_filtering_behavior: "OneDirection" | "BothDirections" | "Automatic";
  is_active: boolean;
};

export type Dataset = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  configured_by: string;
  storage_mode: string;
  has_row_level_security: boolean;
  /** A scan result that failed for this dataset carries this text instead of a schema. */
  schema_retrieval_error: string | null;
  tables: Table[];
  relationships: Relationship[];
  /** Direct shares of the dataset. */
  users: AccessEntry[];
  /** Answer INFO.VIEW queries with Power BI's error, as some tenants' datasets do. */
  refuses_info_views?: boolean;
  /** DAX the mock answers with these rows, besides the table and INFO queries it derives from the model. */
  recorded_queries: { dax: string; rows: Record<string, unknown>[] }[];
};

export type Workspace = {
  id: string;
  name: string;
  type: string;
  state: string;
  /** ISO 8601 UTC; absent means modified now, so every modifiedSince lists it. */
  modified_at?: string;
  users: AccessEntry[];
  /** The scanner answers `users: null` for this workspace, as it does for some real ones; the list still decides access. */
  users_unlisted?: boolean;
  /** A scan holding this workspace answers Failed, with this as its error's message. */
  scan_failure?: string;
  dataset_ids: string[];
  report_ids: string[];
};

export type PowerBiApp = {
  id: string;
  name: string;
  description: string;
  workspace_id: string;
  published_by: string;
  last_update: string;
  users: AccessEntry[];
  report_ids: string[];
};

export type Report = {
  id: string;
  name: string;
  dataset_id: string;
  app_id: string | null;
};

export type Tenant = {
  tenant_id: string;
  people: Person[];
  groups: Group[];
  service_principals: ServicePrincipal[];
  apps_registrations: AppRegistration[];
  settings: TenantSettings;
  workspaces: Workspace[];
  apps: PowerBiApp[];
  reports: Report[];
  datasets: Dataset[];
};

export function defaultTenantSettings(): TenantSettings {
  return {
    detailed_metadata: true,
    dax_expressions: true,
    execute_queries: true,
    service_principals_admin_apis: true,
  };
}
