import { eq, TransactionRollbackError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import { principals, testPool } from "../../../test/deps.js";
import {
  asPerson,
  everyWorkspace,
  fileUnder,
  id,
  metricIn,
  outsider,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { createDb } from "../../db/client.js";
import { setRole } from "../../../test/sample-mirror.js";
import { piiRule } from "../../db/schema/pii.js";
import { term } from "../../db/schema/book.js";
import { powerbiColumn, powerbiRelationship } from "../../db/schema/mirror.js";
import type { Principal } from "../../principal.js";
import { TOOLS } from "../../mcp/tools/index.js";
import {
  getCompanyPartAsAdmin,
  getConventionsForAgents,
  unusedExceptionsAsCurator,
} from "./service.js";
import { setConventions } from "./store.js";

useMirror();

/*
 * An exception names the element it is for, so it shows only to a caller who
 * may see that element: a metric's to whoever sees the metric, a term's to
 * anyone signed in, as term names are. GET /api/v1/conventions and the MCP
 * tool get_conventions answer through getConventionsForAgents. Counts and the
 * admin's own routes name nothing per element, so they stay whole.
 */

const hidden = {
  rule: "naming.case",
  metric: "hidden_orders",
  reason: "Hidden.",
};
const seen = { rule: "naming.case", metric: "seen_orders", reason: "Seen." };
const word = {
  rule: "term_fields.definition",
  term: "Exception channel",
  reason: "Plain.",
};
const curator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const admin = reaching(everyWorkspace.attributes, "admin");

/** Two metrics, one on Finance's profit and one on Sales' net sales, a term, and an exception for each; every one of them passes its rule, so each exception is unused. */
async function excepted(tx: Db): Promise<void> {
  await fileUnder(tx, await metricIn(tx, hidden.metric), id.profit);
  await fileUnder(tx, await metricIn(tx, seen.metric), id.net_sales);
  await tx
    .insert(term)
    .values({ name: word.term, definition: "How the order came in." });
  await setConventions({ db: tx }, principals.admin, {
    format: 1,
    exceptions: [hidden, seen, word],
  });
}

const forAgents = async (tx: Db, principal: Principal) =>
  (await getConventionsForAgents(asPerson(principal, { db: tx }))).rules
    .exceptions;

const unused = async (tx: Db, principal: Principal) =>
  (await unusedExceptionsAsCurator(asPerson(principal, { db: tx }))).map(
    ({ rule, target, reason }) => ({ rule, ...target, reason }),
  );

const onTheConnector = async (tx: Db, principal: Principal) => {
  const tool = TOOLS.find(({ name }) => name === "get_conventions");
  const answer = await tool?.call(asPerson(principal, { db: tx }), {});
  return answer?.content.map((block) => block.text).join("") ?? "";
};

describe("an unused exception on an element", () => {
  it("is judged on the model the curator is shown, so it never tells of a hidden PII column", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        // Order date is numeric and joined only to the Date table's Date column, a PII column.
        await setRole(tx, "worker_rw");
        await tx
          .update(powerbiRelationship)
          .set({ cardinality: "many_to_one" })
          .where(eq(powerbiRelationship.dataset_id, id.sales));
        await tx
          .update(powerbiColumn)
          .set({ data_type: "Int64" })
          .where(eq(powerbiColumn.id, id.order_date));
        await tx.insert(powerbiColumn).values({
          dataset_id: id.sales,
          table_id: id.date_table,
          name: "Date",
          data_type: "DateTime",
          column_type: "data",
        });
        await setRole(tx, "api_rw");
        await tx.insert(piiRule).values({
          kind: "column",
          table_name: "Date",
          name: "Date",
          set_by_kind: "person",
          set_by_id: principals.admin.id,
          set_via: "browser",
          pii: true,
        });
        const unit = {
          rule: "column_fields.unit",
          dataset: "Sales",
          column: "'Sales'[Order date]",
          reason: "Counted, not measured.",
        };
        await setConventions({ db: tx }, principals.admin, {
          format: 1,
          exceptions: [unit],
        });
        // To a PII reader Order date is a key, asked for no unit, so the exception is unused.
        const reader = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
        expect(
          await unused(tx, {
            ...reader,
            roles: [...reader.roles, "pii_reader"],
          }),
        ).toEqual([unit]);
        // To a curator who may not read PII it is no key: the exception is in use, and nothing is listed.
        expect(await unused(tx, curator)).toEqual([]);
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));
});

describe("an exception on a metric the caller cannot see", () => {
  it("is left out of the conventions agents read, on the connector too", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      expect(await forAgents(tx, curator)).toEqual([seen, word]);
      expect(await forAgents(tx, outsider)).toEqual([word]);
      const connector = await onTheConnector(tx, curator);
      expect(connector).toContain(seen.metric);
      expect(connector).not.toContain(hidden.metric);
    }));

  it("is left out of the whole book's unused exceptions", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      expect(await unused(tx, curator)).toEqual([seen, word]);
    }));

  it("shows to an admin who sees the metric, and stays in the counts and the company's part", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      expect(await forAgents(tx, admin)).toEqual([hidden, seen, word]);
      expect(await unused(tx, admin)).toEqual([hidden, seen, word]);
      const { summary } = await getConventionsForAgents(
        asPerson(curator, { db: tx }),
      );
      expect(summary).toContainEqual(expect.stringMatching(/^3 exceptions /));
      const company = await getCompanyPartAsAdmin(
        asPerson(principals.admin, { db: tx }),
      );
      expect(company.exceptions).toEqual([hidden, seen, word]);
    }));
});

describe("element exception visibility", () => {
  it.each([
    { rule: "dataset_fields.definition", dataset: "Sales" },
    { rule: "table_fields.definition", dataset: "Sales", table: "Sales" },
    {
      rule: "column_fields.definition",
      dataset: "Sales",
      column: "'Sales'[Channel]",
    },
  ])("shows $rule only through a describable dataset", (target) =>
    rolledBack(async (tx) => {
      const item = { ...target, reason: "Kept." };
      await setConventions({ db: tx }, principals.admin, {
        format: 1,
        exceptions: [item],
      });
      expect(await forAgents(tx, curator)).toEqual([item]);
      expect(await forAgents(tx, outsider)).toEqual([]);
    }),
  );

  it.each([
    { rule: "dataset_fields.definition", dataset: "Missing" },
    { rule: "table_fields.definition", dataset: "Sales", table: "Missing" },
    {
      rule: "column_fields.definition",
      dataset: "Sales",
      column: "'Sales'[Missing]",
    },
    { rule: "dataset_fields.definition", dataset: "Sales 2023" },
  ])(
    "leaves a missing or removed $rule target only in the admin's part",
    (target) =>
      rolledBack(async (tx) => {
        const item = { ...target, reason: "Gone." };
        await setConventions({ db: tx }, principals.admin, {
          format: 1,
          exceptions: [item],
        });
        expect(await forAgents(tx, admin)).toEqual([]);
        expect(
          (await getCompanyPartAsAdmin(asPerson(principals.admin, { db: tx })))
            .exceptions,
        ).toEqual([item]);
        expect(await unused(tx, admin)).toEqual([]);
      }),
  );

  it("hides a PII column exception from non-readers in agents' conventions and unused lists", () =>
    rolledBack(async (tx) => {
      await tx.insert(piiRule).values({
        kind: "column",
        table_name: "Sales",
        name: "Channel",
        pii: true,
        set_by_kind: "person",
        set_by_id: "test",
        set_via: "api",
      });
      const item = {
        rule: "column_fields.blank_means",
        dataset: "Sales",
        column: "'Sales'[Channel]",
        reason: "Optional.",
      };
      await setConventions({ db: tx }, principals.admin, {
        format: 1,
        exceptions: [item],
      });
      expect(await forAgents(tx, curator)).toEqual([]);
      expect(await unused(tx, curator)).toEqual([]);
      const reader = {
        ...curator,
        roles: [...curator.roles, "pii_reader" as const],
      };
      expect(await forAgents(tx, reader)).toEqual([item]);
      expect(await unused(tx, reader)).toEqual([item]);
    }));
});
