import { randomUUID } from "node:crypto";
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
import {
  powerbiColumn,
  powerbiDataset,
  powerbiRelationship,
} from "../../db/schema/mirror.js";
import type { Principal } from "../../principal.js";
import { TOOLS } from "../../mcp/tools/index.js";
import { docsChecks } from "../book/docs.js";
import {
  applyAsAdmin,
  getCompanyPartAsAdmin,
  getConventionsForAgents,
  unusedExceptionsAsCurator,
  visibleExceptions,
} from "./service.js";
import type { Conventions } from "./schema.js";
import { setConventions } from "./store.js";

useMirror();

/*
 * An exception names the element it is for, so it shows only to a caller who
 * may see that element (visibleExceptions): a metric's to whoever sees the
 * metric, a term's to anyone signed in, as term names are. The unused lists
 * and a baseline go through it. GET /api/v1/conventions and the MCP tool
 * get_conventions answer through getConventionsForAgents, which names no
 * exception at all: it counts them per rule. Counts and the admin's own
 * routes name nothing per element, so they stay whole.
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

const visibleTo = async (
  tx: Db,
  principal: Principal,
  exceptions: Conventions["exceptions"],
) => visibleExceptions(asPerson(principal, { db: tx }), exceptions);

const unused = async (tx: Db, principal: Principal) =>
  (await unusedExceptionsAsCurator(asPerson(principal, { db: tx }))).map(
    ({ rule, target, reason }) => ({ rule, ...target, reason }),
  );

const onTheConnector = async (tx: Db, principal: Principal) => {
  const tool = TOOLS.find(({ name }) => name === "get_conventions");
  const answer = await tool?.call(asPerson(principal, { db: tx }), {});
  return answer?.content.map((block) => block.text).join("") ?? "";
};

/** Order date is numeric and joined only to the Date table's Date column, a PII column. */
async function orderDateJoinedOnlyToPii(tx: Db): Promise<void> {
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
}

describe("an unused exception on an element", () => {
  it("is judged on the model the curator is shown, so it never tells of a hidden PII column", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        await orderDateJoinedOnlyToPii(tx);
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

  it("is ambiguous when a dataset the curator cannot see shares its dataset's name, as it applies to nothing", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        const item = {
          rule: "dataset_fields.definition",
          dataset: "Sales",
          reason: "Kept.",
        };
        await setRole(tx, "api_rw");
        await setConventions({ db: tx }, principals.admin, {
          format: 1,
          exceptions: [item],
        });
        const why = async () =>
          (await unusedExceptionsAsCurator(asPerson(curator, { db: tx }))).map(
            (each) => each.why,
          );
        expect(await why()).toEqual(["passes"]);
        // A second live Sales, in a workspace the curator does not reach.
        await setRole(tx, "worker_rw");
        await tx.insert(powerbiDataset).values({
          id: randomUUID(),
          workspace_id: id.twin_workspace,
          name: "Sales",
        });
        await setRole(tx, "api_rw");
        expect(await why()).toEqual(["ambiguous"]);
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));
});

describe("a baseline run by an admin who cannot read PII", () => {
  it("excepts a column joined only to a PII column exactly when that admin's docs check shows it failing", () =>
    expect(
      createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
        await orderDateJoinedOnlyToPii(tx);
        const salesAdmin = reaching(
          { powerbi_app_ids: [id.sales_app] },
          "admin",
        );
        const reader: Principal = {
          ...salesAdmin,
          roles: [...salesAdmin.roles, "pii_reader"],
        };
        // To the admin Order date is no key and fails; to a PII reader it is a key and passes.
        for (const [principal, fails] of [
          [salesAdmin, true],
          [reader, false],
        ] as const) {
          await setConventions({ db: tx }, principals.admin, {
            format: 1,
            column_fields: { unit: { required: false } },
          });
          // The preset's when_numeric comes back on.
          const answer = await applyAsAdmin(asPerson(principal, { db: tx }), {
            conventions: { format: 1 },
            dry_run: true,
            baseline_reason: "Measured before units.",
          });
          // The docs check under the same change, before any exception.
          await setConventions({ db: tx }, principals.admin, { format: 1 });
          const checks = await docsChecks(asPerson(principal, { db: tx }), {
            dataset: "Sales",
            limit: 500,
          });
          const failing = checks.items.some(
            (item) =>
              item.id === id.order_date &&
              item.results.some(
                (result) =>
                  result.rule === "column_fields.unit" && !result.passed,
              ),
          );
          const excepted = answer.exceptions_added.some(
            (item) =>
              item.rule === "column_fields.unit" &&
              item.column === "'Sales'[Order date]",
          );
          expect(failing).toBe(fails);
          expect(excepted).toBe(fails);
        }
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError));
});

describe("the unused list on the documentation checks", () => {
  it("goes to a curator, on the first page alone, and to no viewer or service account without curation", () =>
    rolledBack(async (tx) => {
      const item = {
        rule: "dataset_fields.definition",
        dataset: "Sales",
        reason: "Kept.",
      };
      await setConventions({ db: tx }, principals.admin, {
        format: 1,
        exceptions: [item],
      });
      const viewer = reaching({ powerbi_app_ids: [id.sales_app] });
      const account: Principal = {
        ...viewer,
        kind: "service_account",
        id: "docs-check-account",
        via: "api",
      };
      for (const principal of [viewer, account])
        expect(
          await docsChecks(asPerson(principal, { db: tx }), { limit: 1 }),
        ).not.toHaveProperty("unused_exceptions");
      const first = await docsChecks(asPerson(curator, { db: tx }), {
        limit: 1,
      });
      expect(first.unused_exceptions).toEqual([
        {
          rule: item.rule,
          target: { dataset: "Sales" },
          reason: item.reason,
          why: "passes",
        },
      ]);
      expect(first.next_cursor).not.toBeNull();
      const second = await docsChecks(asPerson(curator, { db: tx }), {
        limit: 1,
        cursor: first.next_cursor ?? "",
      });
      expect(second.items).toHaveLength(1);
      expect(second).not.toHaveProperty("unused_exceptions");
    }));
});

describe("the conventions agents read", () => {
  it("name no exception's target or reason, even to an admin who sees them all, on the connector too: they count exceptions per rule", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      const named = [hidden, seen, word].flatMap(({ reason, ...target }) => [
        reason,
        ...Object.values(target).filter((value) => value !== target.rule),
      ]);
      for (const principal of [admin, curator, outsider]) {
        const answer = await getConventionsForAgents(
          asPerson(principal, { db: tx }),
        );
        expect(answer.exceptions).toEqual({
          "naming.case": 2,
          "term_fields.definition": 1,
        });
        expect(answer.rules).not.toHaveProperty("exceptions");
        const text = [
          JSON.stringify(answer),
          await onTheConnector(tx, principal),
        ].join("");
        for (const name of named) expect(text).not.toContain(name);
      }
    }));
});

describe("an exception on a metric the caller cannot see", () => {
  it("is left out of what visibleExceptions shows", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      const all = [hidden, seen, word];
      expect(await visibleTo(tx, curator, all)).toEqual([seen, word]);
      expect(await visibleTo(tx, outsider, all)).toEqual([word]);
    }));

  it("is left out of the whole book's unused exceptions", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      expect(await unused(tx, curator)).toEqual([seen, word]);
    }));

  it("shows to an admin who sees the metric, and stays in the counts and the company's part", () =>
    rolledBack(async (tx) => {
      await excepted(tx);
      expect(await visibleTo(tx, admin, [hidden, seen, word])).toEqual([
        hidden,
        seen,
        word,
      ]);
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

describe("a baseline run by an admin who cannot see a metric", () => {
  it("neither lists nor saves an exception for it, and still counts its failure", () =>
    rolledBack(async (tx) => {
      await fileUnder(tx, await metricIn(tx, hidden.metric), id.profit);
      await fileUnder(tx, await metricIn(tx, seen.metric), id.net_sales);
      // Neither name has a kind, so turning naming.kinds on makes both fail.
      await setConventions({ db: tx }, principals.admin, {
        format: 1,
        off: ["naming.kinds"],
      });
      const input = {
        conventions: { format: 1 },
        baseline_reason: "Named before the house style.",
      };
      const excepted = (answer: { exceptions_added: { metric?: string }[] }) =>
        answer.exceptions_added.map(({ metric }) => metric);
      const whole = await applyAsAdmin(asPerson(admin, { db: tx }), {
        ...input,
        dry_run: true,
      });
      expect(excepted(whole)).toEqual(
        expect.arrayContaining([hidden.metric, seen.metric]),
      );
      const salesAdmin = reaching({ powerbi_app_ids: [id.sales_app] }, "admin");
      const answer = await applyAsAdmin(asPerson(salesAdmin, { db: tx }), {
        ...input,
        dry_run: false,
      });
      expect(excepted(answer)).toContain(seen.metric);
      expect(excepted(answer)).not.toContain(hidden.metric);
      expect(answer.now_failing).toEqual(whole.now_failing);
      const company = await getCompanyPartAsAdmin(
        asPerson(principals.admin, { db: tx }),
      );
      expect(company.exceptions).toEqual(answer.exceptions_added);
      expect(JSON.stringify(company)).not.toContain(hidden.metric);
    }));
});

describe("element exception visibility", () => {
  it.each([
    { rule: "dataset_fields.definition", dataset: "Sales" },
    { rule: "dataset_fields.definition", dataset: id.sales },
    { rule: "table_fields.definition", dataset: id.sales, table: "Sales" },
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
      expect(await visibleTo(tx, curator, [item])).toEqual([item]);
      expect(await visibleTo(tx, outsider, [item])).toEqual([]);
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
        expect(await visibleTo(tx, admin, [item])).toEqual([]);
        expect(
          (await getCompanyPartAsAdmin(asPerson(principals.admin, { db: tx })))
            .exceptions,
        ).toEqual([item]);
        expect(await unused(tx, admin)).toEqual([]);
      }),
  );

  it("hides a PII column exception from non-readers, in what visibleExceptions shows and the unused lists", () =>
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
      expect(await visibleTo(tx, curator, [item])).toEqual([]);
      expect(await unused(tx, curator)).toEqual([]);
      const reader = {
        ...curator,
        roles: [...curator.roles, "pii_reader" as const],
      };
      expect(await visibleTo(tx, reader, [item])).toEqual([item]);
      expect(await unused(tx, reader)).toEqual([item]);
    }));
});
