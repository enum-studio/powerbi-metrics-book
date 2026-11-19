import { describe, expect, it } from "vitest";
import { principals } from "../../../test/deps.js";
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
import { term } from "../../db/schema/book.js";
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
