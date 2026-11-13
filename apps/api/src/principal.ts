/** Who is calling: a person or a service account, resolved on every request. */
export type Principal = {
  kind: "person" | "service_account";
  /** Better Auth user id, or the service account's name. */
  id: string;
  /** Resolved on every request from role_assignment. */
  roles: string[];
  /** Includes powerbi_workspace_ids, powerbi_app_ids and powerbi_dataset_ids. */
  attributes: Record<string, string[]>;
  via: "browser" | "mcp" | "api" | "cli";
  /** The OAuth client, for mcp and cli. */
  client_id: string | null;
};
