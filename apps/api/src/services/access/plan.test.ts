import { randomUUID } from "node:crypto";
import {
  PlanExpression,
  PlanExpressionValue,
  PlanExpressionVariable,
  PlanKind,
  type PlanExpressionOperand,
  type PlanResourcesResponse,
  type Value,
} from "@cerbos/core";
import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import { powerbiDataset } from "../../db/schema/mirror.js";
import { inRollback } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";
import {
  planCondition,
  queryLogPlanCondition,
  requestPlanCondition,
  searchLogPlanCondition,
} from "./plan.js";

afterAll(closeTestPools);

const ids = {
  member_workspace: randomUUID(),
  app_workspace: randomUUID(),
  sales_app: randomUUID(),
  member_dataset: randomUUID(),
  app_dataset: randomUUID(),
  shared_dataset: randomUUID(),
};
const everyDataset = [ids.member_dataset, ids.app_dataset, ids.shared_dataset];

/** Runs the plan's condition over the seeded datasets, in a transaction that is rolled back. */
function visible(plan: PlanResourcesResponse): Promise<string[]> {
  const condition = planCondition(plan);
  return inRollback(testPool("worker_rw"), async (client) => {
    // One statement: a foreign key is checked when it ends, so the order does not matter.
    await client.query(
      `with w as (insert into powerbi_workspace (id, name) values ($1, 'Sample data members'), ($2, 'Sample data apps')),
            a as (insert into powerbi_app (id, name, workspace_id) values ($3, 'Sample data Sales', $2)),
            d as (insert into powerbi_dataset (id, workspace_id, name, endorsement) values
                    ($4, $1, 'Sample data members', 'Certified'), ($5, $2, 'Sample data sales', null),
                    ($6, $2, 'Sample data shared', null))
       insert into powerbi_app_dataset (app_id, dataset_id) values ($3, $5)`,
      [ids.member_workspace, ids.app_workspace, ids.sales_app, ...everyDataset],
    );
    const rows = await drizzle({ client })
      .select({ id: powerbiDataset.id })
      .from(powerbiDataset)
      .where(and(condition, inArray(powerbiDataset.id, everyDataset)));
    return rows.map((row) => row.id).sort();
  });
}

function conditional(condition: PlanExpressionOperand): PlanResourcesResponse {
  return {
    kind: PlanKind.CONDITIONAL,
    condition,
    cerbosCallId: "",
    requestId: "",
    validationErrors: [],
    metadata: undefined,
  };
}

function unconditional(
  kind: PlanKind.ALWAYS_ALLOWED | PlanKind.ALWAYS_DENIED,
): PlanResourcesResponse {
  return {
    kind,
    cerbosCallId: "",
    requestId: "",
    validationErrors: [],
    metadata: undefined,
  };
}

const op = (operator: string, ...operands: PlanExpressionOperand[]) =>
  new PlanExpression(operator, operands);
const attr = (name: string) =>
  new PlanExpressionVariable(`request.resource.${name}`);
const value = (v: Value) => new PlanExpressionValue(v);

describe("planCondition", () => {
  it("lets every dataset through when the plan always allows, and none when it always denies", async () => {
    expect(await visible(unconditional(PlanKind.ALWAYS_ALLOWED))).toEqual(
      [...everyDataset].sort(),
    );
    expect(await visible(unconditional(PlanKind.ALWAYS_DENIED))).toEqual([]);
  });

  // The shapes Cerbos plans from the default policies: `in` for two or more
  // ids, `eq` for one, hasIntersection for apps, `or` across the three.
  it("translates a workspace list as in, and a single workspace as eq", async () => {
    const both = op(
      "in",
      attr("attr.workspace_id"),
      value([ids.member_workspace, ids.app_workspace]),
    );
    expect(await visible(conditional(both))).toEqual([...everyDataset].sort());
    const one = op(
      "eq",
      attr("attr.workspace_id"),
      value(ids.member_workspace),
    );
    expect(await visible(conditional(one))).toEqual([ids.member_dataset]);
  });

  it("translates a direct share as eq on the id, in either order", async () => {
    for (const shared of [
      op("eq", attr("id"), value(ids.shared_dataset)),
      op("eq", value(ids.shared_dataset), attr("id")),
    ])
      expect(await visible(conditional(shared))).toEqual([ids.shared_dataset]);
  });

  it("translates an app intersection through powerbi_app_dataset, empty as nothing", async () => {
    const sales = op(
      "hasIntersection",
      attr("attr.app_ids"),
      value([ids.sales_app, randomUUID()]),
    );
    expect(await visible(conditional(sales))).toEqual([ids.app_dataset]);
    const none = op("hasIntersection", attr("attr.app_ids"), value([]));
    expect(await visible(conditional(none))).toEqual([]);
  });

  it("joins with or, and, not", async () => {
    const workspace = op(
      "eq",
      attr("attr.workspace_id"),
      value(ids.member_workspace),
    );
    const share = op("eq", attr("id"), value(ids.shared_dataset));
    expect(await visible(conditional(op("or", workspace, share)))).toEqual(
      [ids.member_dataset, ids.shared_dataset].sort(),
    );
    const appsNotShared = op(
      "and",
      op("eq", attr("attr.workspace_id"), value(ids.app_workspace)),
      op("not", share),
    );
    expect(await visible(conditional(appsNotShared))).toEqual([
      ids.app_dataset,
    ]);
  });

  it("translates the dataset's own columns a deployment's policy may name", async () => {
    const certified = op("eq", attr("attr.endorsement"), value("Certified"));
    expect(await visible(conditional(certified))).toEqual([ids.member_dataset]);
  });

  it.each([
    [
      "an operator it does not know",
      op("lt", attr("attr.workspace_id"), value("x")),
    ],
    // What Cerbos plans when the api leaves a principal's list out.
    [
      "a principal attribute Cerbos could not resolve",
      op(
        "hasIntersection",
        attr("attr.app_ids"),
        op("get-field", op("struct"), new PlanExpressionVariable("x")),
      ),
    ],
    [
      "an attribute with no column",
      op("eq", attr("attr.workspace_name"), value("Sample data members")),
    ],
    [
      "a value in a list attribute",
      op("in", value(ids.sales_app), attr("attr.app_ids")),
    ],
    ["a bare value", value(true)],
    ["text that is no uuid, for the id", op("eq", attr("id"), value("abc"))],
    [
      "text that is no uuid, in a list",
      op("in", attr("attr.workspace_id"), value([ids.member_workspace, "abc"])),
    ],
    ["null", op("eq", attr("attr.endorsement"), value(null))],
    ["a number for text", op("eq", attr("attr.endorsement"), value(5))],
    [
      "text for a boolean",
      op("eq", attr("attr.has_row_level_security"), value("yes")),
    ],
    ["a list that is none", op("in", attr("id"), value(ids.shared_dataset))],
    [
      "an app id that is no uuid",
      op("hasIntersection", attr("attr.app_ids"), value(["abc"])),
    ],
  ])("throws on %s", (_, condition) => {
    expect(() => planCondition(conditional(condition))).toThrow(
      "from the dataset:describe policy",
    );
  });
});

describe("queryLogPlanCondition", () => {
  it.each([
    [
      "an attribute of a dataset",
      op("eq", attr("attr.workspace_id"), value("x")),
    ],
    [
      "an attribute the check does not send",
      op("eq", attr("attr.dataset_id"), value("x")),
    ],
    [
      "the apps of a dataset",
      op("hasIntersection", attr("attr.app_ids"), value(["x"])),
    ],
    ["an unknown operator", op("ne", attr("attr.principal_id"), value("x"))],
    ["text that is no uuid, for the id", op("eq", attr("id"), value("abc"))],
    ["null", op("eq", attr("attr.principal_id"), value(null))],
    ["a number for text", op("eq", attr("attr.principal_id"), value(5))],
  ])("throws on %s, naming the rule", (_, condition) => {
    expect(() => queryLogPlanCondition(conditional(condition))).toThrow(
      "from the query_log:read policy",
    );
  });
});

describe.each(["request", "search_log"] as const)("%s read plan", (kind) => {
  const translate = (plan: PlanResourcesResponse) => {
    const fn =
      kind === "request" ? requestPlanCondition : searchLogPlanCondition;
    return new PgDialect().sqlToQuery(fn(plan));
  };

  it.each(["person", "service_account"])(
    "translates record_owner for a %s on both columns",
    (principalKind) => {
      // Roles are ORed with record_owner: for a viewer, Cerbos leaves ownership.
      const owner = op(
        "and",
        op("eq", attr("attr.principal_kind"), value(principalKind)),
        op("eq", attr("attr.principal_id"), value("sample_caller")),
      );
      expect(translate(conditional(owner))).toMatchObject({
        sql: `("${kind}"."principal_kind" = $1 and "${kind}"."principal_id" = $2)`,
        params: [principalKind, "sample_caller"],
      });
    },
  );

  it("maps always-allowed to true and always-denied to false", () => {
    expect(translate(unconditional(PlanKind.ALWAYS_ALLOWED)).sql).toBe("true");
    expect(translate(unconditional(PlanKind.ALWAYS_DENIED)).sql).toBe("false");
  });

  it.each([
    ["an unknown attribute", op("eq", attr("attr.workspace_id"), value("x"))],
    ["an unknown operator", op("ne", attr("attr.principal_id"), value("x"))],
  ])("throws on %s, naming the rule", (_, condition) => {
    expect(() => translate(conditional(condition))).toThrow(
      `from the ${kind}:read policy`,
    );
  });
});
