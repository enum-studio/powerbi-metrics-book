import {
  PlanExpression,
  PlanExpressionValue,
  PlanExpressionVariable,
  PlanKind,
  planResourcesResponseIsConditional,
  type PlanExpressionOperand,
  type PlanResourcesResponse,
  type Value,
} from "@cerbos/core";
import { and, eq, not, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { powerbiAppDataset, powerbiDataset } from "../../db/schema/mirror.js";
import { queryLog } from "../../db/schema/queries.js";
import { request, searchLog } from "../../db/schema/usage.js";

/*
 * Lists and search filter datasets inside their SQL, so Cerbos's plan for
 * dataset:describe becomes a condition over powerbi_dataset. The query log's
 * search does the same with query_log:read. Request and search log lists use
 * request:read and search_log:read, so pages, cursors and aggregates are made
 * from entries the principal may read. Only shapes this file knows are
 * translated. Any other operator, attribute or value throws, naming the rule,
 * so a policy the translator cannot follow fails the request instead of
 * showing more than the policy allows, and whoever reads the log knows which
 * policy to fix.
 */

/** What one action's policy may be translated over. */
type Translation = {
  rule: string;
  columns: Map<string, PgColumn>;
  /** Whether app_ids means the apps showing a dataset. */
  apps: boolean;
};

/** The dataset attributes held in a column of powerbi_dataset itself. */
const DATASET_COLUMNS = new Map<string, PgColumn>([
  ["request.resource.id", powerbiDataset.id],
  ["request.resource.attr.workspace_id", powerbiDataset.workspace_id],
  [
    "request.resource.attr.has_row_level_security",
    powerbiDataset.has_row_level_security,
  ],
  ["request.resource.attr.endorsement", powerbiDataset.endorsement],
  ["request.resource.attr.sensitivity_label", powerbiDataset.sensitivity_label],
]);

/** The apps showing a dataset, which live in powerbi_app_dataset. */
const APP_IDS = "request.resource.attr.app_ids";

const DATASET_DESCRIBE: Translation = {
  rule: "dataset:describe",
  columns: DATASET_COLUMNS,
  apps: true,
};

/** What readable in services/queries/log.ts sends about an entry, each held in a column of query_log. */
const QUERY_LOG_READ: Translation = {
  rule: "query_log:read",
  columns: new Map<string, PgColumn>([
    ["request.resource.id", queryLog.id],
    ["request.resource.attr.principal_kind", queryLog.principal_kind],
    ["request.resource.attr.principal_id", queryLog.principal_id],
  ]),
  apps: false,
};

const REQUEST_READ: Translation = {
  rule: "request:read",
  columns: new Map<string, PgColumn>([
    ["request.resource.id", request.id],
    ["request.resource.attr.principal_kind", request.principal_kind],
    ["request.resource.attr.principal_id", request.principal_id],
  ]),
  apps: false,
};

const SEARCH_LOG_READ: Translation = {
  rule: "search_log:read",
  columns: new Map<string, PgColumn>([
    ["request.resource.id", searchLog.id],
    ["request.resource.attr.principal_kind", searchLog.principal_kind],
    ["request.resource.attr.principal_id", searchLog.principal_id],
  ]),
  apps: false,
};

/** A Cerbos query plan for dataset:describe as a condition over powerbi_dataset. */
export function planCondition(plan: PlanResourcesResponse): SQL {
  return translated(plan, DATASET_DESCRIBE);
}

/** A Cerbos query plan for query_log:read as a condition over query_log. */
export function queryLogPlanCondition(plan: PlanResourcesResponse): SQL {
  return translated(plan, QUERY_LOG_READ);
}

/** A Cerbos query plan for request:read as a condition over request. */
export function requestPlanCondition(plan: PlanResourcesResponse): SQL {
  return translated(plan, REQUEST_READ);
}

/** A Cerbos query plan for search_log:read as a condition over search_log. */
export function searchLogPlanCondition(plan: PlanResourcesResponse): SQL {
  return translated(plan, SEARCH_LOG_READ);
}

function translated(plan: PlanResourcesResponse, over: Translation): SQL {
  if (planResourcesResponseIsConditional(plan))
    return condition(plan.condition, over);
  return plan.kind === PlanKind.ALWAYS_ALLOWED ? sql`true` : sql`false`;
}

function condition(operand: PlanExpressionOperand, over: Translation): SQL {
  if (!(operand instanceof PlanExpression)) throw untranslatable(operand, over);
  const inner = (part: PlanExpressionOperand) => condition(part, over);
  switch (operand.operator) {
    case "and":
      return joined(operand, over, and(...operand.operands.map(inner)));
    case "or":
      return joined(operand, over, or(...operand.operands.map(inner)));
    case "not": {
      const [negated] = operand.operands;
      if (operand.operands.length !== 1 || negated === undefined)
        throw untranslatable(operand, over);
      return not(inner(negated));
    }
    case "eq": {
      const { name, value } = attributeAndValue(operand, over);
      const column = columnOf(name, operand, over);
      if (!fits(column, value)) throw untranslatable(operand, over);
      return eq(column, value);
    }
    case "in": {
      // Only an attribute in a list: a value in a list attribute is another
      // query, and no default policy asks it.
      const [attribute, list] = operand.operands;
      if (
        operand.operands.length !== 2 ||
        !(attribute instanceof PlanExpressionVariable) ||
        !(list instanceof PlanExpressionValue)
      )
        throw untranslatable(operand, over);
      const column = columnOf(attribute.name, operand, over);
      const values = listOf(list.value, operand, over);
      if (!values.every((one): one is string | boolean => fits(column, one)))
        throw untranslatable(operand, over);
      return anyOf(column, values);
    }
    case "hasIntersection": {
      const { name, value } = attributeAndValue(operand, over);
      const appIds = listOf(value, operand, over);
      if (
        !over.apps ||
        name !== APP_IDS ||
        !appIds.every((id): id is string => fits(powerbiAppDataset.app_id, id))
      )
        throw untranslatable(operand, over);
      return shownByApps(appIds);
    }
    default:
      throw untranslatable(operand, over);
  }
}

/**
 * The column is one of the values, sent as one array parameter: a list of
 * one parameter per value fails past Postgres's 65,535, and a person can
 * reach that many ids.
 */
export function anyOf(
  column: PgColumn,
  values: readonly (string | number | boolean)[],
): SQL {
  return sql`${column} = any(${sql.param(values)})`;
}

/** The datasets one of these apps shows. */
export function shownByApps(appIds: string[]): SQL {
  return sql`exists (select 1 from ${powerbiAppDataset} where ${powerbiAppDataset.dataset_id} = ${powerbiDataset.id} and ${anyOf(powerbiAppDataset.app_id, appIds)})`;
}

function joined(
  operand: PlanExpression,
  over: Translation,
  joinedSql: SQL | undefined,
): SQL {
  if (joinedSql === undefined) throw untranslatable(operand, over);
  return joinedSql;
}

/** The attribute and the value an operator compares, in either order. */
function attributeAndValue(
  operand: PlanExpression,
  over: Translation,
): {
  name: string;
  value: Value;
} {
  const [first, second] = operand.operands;
  if (operand.operands.length === 2) {
    if (
      first instanceof PlanExpressionVariable &&
      second instanceof PlanExpressionValue
    )
      return { name: first.name, value: second.value };
    if (
      first instanceof PlanExpressionValue &&
      second instanceof PlanExpressionVariable
    )
      return { name: second.name, value: first.value };
  }
  throw untranslatable(operand, over);
}

function columnOf(
  name: string,
  operand: PlanExpression,
  over: Translation,
): PgColumn {
  const column = over.columns.get(name);
  if (column === undefined) throw untranslatable(operand, over);
  return column;
}

/**
 * Whether a literal can be compared with the column. Postgres refuses text
 * that is no uuid, in an error that names no policy, and casts a number to
 * text, where Cerbos would find a number and a string unequal.
 */
function fits(column: PgColumn, value: Value): value is string | boolean {
  switch (column.getSQLType()) {
    case "uuid":
      return z.guid().safeParse(value).success;
    case "boolean":
      return typeof value === "boolean";
    default:
      return typeof value === "string";
  }
}

function listOf(
  value: Value,
  operand: PlanExpression,
  over: Translation,
): Value[] {
  if (!Array.isArray(value)) throw untranslatable(operand, over);
  return value;
}

function untranslatable(
  operand: PlanExpressionOperand,
  over: Translation,
): Error {
  return new Error(
    `access plan: src/services/access/plan.ts cannot translate ${JSON.stringify(operand)} from the ${over.rule} policy, so lists refuse rather than show too much`,
  );
}
