import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, failed, read } from "../../api/client";
import type { operations } from "../../api/schema";
import { ADMIN_KEY } from "../settings/api";

export type RuleInput =
  operations["putApiV1AdminPiiRules"]["requestBody"]["content"]["application/json"];
export type Rule =
  operations["getApiV1AdminPiiRules"]["responses"][200]["content"]["application/json"]["rules"][number];
export const PII_KEY = [...ADMIN_KEY, "pii"];
export const rulesQuery = queryOptions({
  queryKey: [...PII_KEY, "rules"],
  queryFn: async () => (await read(api.GET("/api/v1/admin/pii/rules"))).rules,
  retry: false,
});
export const suggestionsQuery = queryOptions({
  queryKey: [...PII_KEY, "suggestions"],
  queryFn: async () =>
    (await read(api.GET("/api/v1/admin/pii/suggestions"))).suggestions,
  retry: false,
});
export const putRule = (body: RuleInput) =>
  read(api.PUT("/api/v1/admin/pii/rules", { body }));
export async function deleteRule(
  id: string,
  expectedVersion?: string,
): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/admin/pii/rules/{id}", {
    params: {
      path: { id },
      query: {
        expected_version: expectedVersion,
      },
    },
  });
  if (!response.ok) throw failed(response.status, error);
}

/** Undo restores the definition; the server attributes this new decision to its caller. */
export const ruleInput = (
  rule: Pick<Rule, "kind" | "table_name" | "name" | "pii" | "note">,
): RuleInput => ({
  kind: rule.kind,
  table: rule.table_name,
  ...(rule.name === null ? {} : { name: rule.name }),
  pii: rule.pii,
  note: rule.note,
});
export async function undoSave({
  before,
  rule,
}: Awaited<ReturnType<typeof putRule>>) {
  if (before === null) await deleteRule(rule.id, rule.version);
  else await putRule({ ...ruleInput(before), expected_version: rule.version });
}
export const undoError = (error: Error): string =>
  `${error.message}${error instanceof ApiError && error.kind === "conflict" ? " Nothing was undone." : ""}`;
export const reference = (table: string, name: string | null) =>
  `'${table.replaceAll("'", "''")}'${name === null ? "" : `[${name.replaceAll("]", "]]")}]`}`;
export function viaWords(via: string): string {
  switch (via) {
    case "browser":
      return "in the browser";
    case "cli":
      return "with the CLI";
    case "mcp":
      return "through an agent";
    default:
      return "through the API";
  }
}

/** The API names fields in its validation sentence; it remains the validator. */
export function fieldError(
  error: Error | null,
): "table" | "name" | "note" | null {
  if (!(error instanceof ApiError) || error.kind !== "invalid") return null;
  if (/\b(table_name\b|table:|table name\b)/.test(error.message))
    return "table";
  if (/\bnote\b/.test(error.message)) return "note";
  if (/\bname\b/.test(error.message)) return "name";
  return null;
}
