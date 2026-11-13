import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { inRollback } from "../../../test/database.js";
import { closeTestPools, testPool } from "../../../test/deps.js";

import { GAP_KINDS, REQUEST_OUTCOMES, SEARCH_LOG_VIAS } from "./usage.js";
import { PRINCIPAL_KINDS } from "./queries.js";
import { VIAS } from "./book.js";

afterAll(closeTestPools);

it("refuses a not_answered request with no gaps", async () => {
  await expect(
    inRollback(testPool("audit_writer"), (client) =>
      client.query(
        `insert into request
          (id, at, principal_kind, principal_id, via, question, outcome, gaps)
         values ($1, now(), 'person', 'sample-data-user', 'api',
                 'Sample data question', 'not_answered', '{}')`,
        [randomUUID()],
      ),
    ),
  ).rejects.toThrow('"request_outcome_gaps_check"');
});

it("mirrors each enum in its database CHECK", async () => {
  const sets = {
    request_gaps_check: GAP_KINDS,
    request_outcome_check: REQUEST_OUTCOMES,
    request_via_check: VIAS,
    request_principal_kind_check: PRINCIPAL_KINDS,
    search_log_via_check: SEARCH_LOG_VIAS,
    search_log_principal_kind_check: PRINCIPAL_KINDS,
    search_log_search_mode_check: ["hybrid", "words_only"],
  };
  const { rows } = await testPool("api_rw").query<{
    name: keyof typeof sets;
    definition: string;
  }>(
    "select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where conname = any($1)",
    [Object.keys(sets)],
  );
  expect(rows).toHaveLength(Object.keys(sets).length);
  for (const row of rows)
    expect(
      (row.definition.match(/'[a-z_]+'/g) ?? [])
        .map((v) => v.slice(1, -1))
        .sort(),
    ).toEqual([...sets[row.name]].sort());
});

it.each([["unknown_gap"], ["no_metric", "no_metric"]])(
  "refuses invalid gaps %j",
  async (...gaps) => {
    await expect(
      inRollback(testPool("audit_writer"), (client) =>
        client.query(
          `insert into request (id, at, principal_kind, principal_id, via, question, outcome, gaps)
     values ($1, now(), 'person', 'sample-data-user', 'api', 'Sample data question', 'answered', $2)`,
          [randomUUID(), gaps],
        ),
      ),
    ).rejects.toThrow(/request_gaps.*check/);
  },
);
