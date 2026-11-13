import { and, asc, eq, isNotNull, ne, or } from "drizzle-orm";
import type { Db } from "../../context.js";
import { powerbiAccess } from "../../db/schema/mirror.js";
import { anyOf } from "./plan.js";

/** What Cerbos reads of a principal's reach in Power BI, by Power BI's ids. */
export type PowerbiAttributes = {
  powerbi_workspace_ids: string[];
  powerbi_app_ids: string[];
  powerbi_dataset_ids: string[];
};

/**
 * Whose reach: a person by the Microsoft object id and the Entra groups
 * that still count (roleSubject's freshness), or a service account by the
 * grant its admin gave it.
 */
export type PowerbiHolder =
  | {
      kind: "person";
      microsoft_object_id: string | null;
      group_object_ids: readonly string[];
    }
  | { kind: "service_account"; workspace_ids: string[]; app_ids: string[] };

/**
 * A person reaches what Power BI's access lists (powerbi_access) name them
 * or one of their groups on, with a right that is not None, which Power BI
 * uses to take access away: workspaces, app audiences and datasets shared
 * with them directly. An entry whose right the sync could not read reaches
 * nothing. One query on powerbi_access_principal_idx. Only an Entra object
 * id is matched, never an email, which the list holds only as a label.
 */
export async function powerbiAttributes(
  db: Db,
  holder: PowerbiHolder,
): Promise<PowerbiAttributes> {
  if (holder.kind === "service_account")
    return {
      powerbi_workspace_ids: holder.workspace_ids,
      powerbi_app_ids: holder.app_ids,
      powerbi_dataset_ids: [],
    };
  const t = powerbiAccess;
  const named = [
    ...(holder.microsoft_object_id === null
      ? []
      : [
          and(
            eq(t.principal_type, "user"),
            eq(t.principal_object_id, holder.microsoft_object_id),
          ),
        ]),
    ...(holder.group_object_ids.length === 0
      ? []
      : [
          and(
            eq(t.principal_type, "group"),
            anyOf(t.principal_object_id, holder.group_object_ids),
          ),
        ]),
  ];
  const reached: PowerbiAttributes = {
    powerbi_workspace_ids: [],
    powerbi_app_ids: [],
    powerbi_dataset_ids: [],
  };
  // An empty or() would match every row.
  if (named.length === 0) return reached;
  const rows = await db
    .selectDistinct({ kind: t.object_kind, id: t.object_id })
    .from(t)
    .where(
      and(or(...named), isNotNull(t.access_right), ne(t.access_right, "None")),
    )
    .orderBy(asc(t.object_id));
  const lists = {
    workspace: reached.powerbi_workspace_ids,
    app: reached.powerbi_app_ids,
    dataset: reached.powerbi_dataset_ids,
  };
  for (const row of rows) lists[row.kind].push(row.id);
  return reached;
}
