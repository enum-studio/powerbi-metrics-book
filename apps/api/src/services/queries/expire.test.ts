import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDeps, principals } from "../../../test/deps.js";
import { id, useMirror } from "../../../test/mirror-fixtures.js";
import { accessFrom, MemorySecrets } from "../../../test/doubles.js";
import { event } from "../../db/schema/events.js";
import { queryResult, queryResultPage } from "../../db/schema/queries.js";
import { handlerFor } from "../jobs/registry.js";
import "./expire.js";
import { logQuery } from "./log.js";
import { createResultStore } from "./store.js";

const api = createTestDeps({
  access: accessFrom(() => true),
  secrets: new MemorySecrets([["result_link_key", "test-result-link-key"]]),
});
const worker = createTestDeps({ container: "worker" });
const DAY_MS = 24 * 60 * 60_000;

useMirror();

describe("the expire_results job", () => {
  it("deletes expired results and events past 90 days, keeps the rest, and an expired result still answers with its query", async () => {
    const owner = { ...principals.viewer, id: `owner-${randomUUID()}` };
    const query_id = randomUUID();
    const dataset = { id: id.sales, name: "Sales" };
    const input = {
      query_id,
      owner,
      dataset,
      columns: [{ name: "[Orders]", type: "number" as const }],
      truncation_note: null,
      preview_rows: 20,
    };
    const anchor = await createResultStore(api).save(input, [[3012]]);
    await logQuery(
      { ...api, principal: owner },
      {
        id: query_id,
        at: api.clock(),
        dataset: { ...dataset, workspace_id: randomUUID() },
        dax: "EVALUATE {[Orders]}",
        purpose: null,
        status: "succeeded",
        error: null,
        duration_ms: 40,
        measure_names: ["Orders"],
        metric_ids: [],
        result: {
          id: anchor.result_id,
          row_count: 1,
          column_count: 1,
          bytes: anchor.bytes,
          expires_at: new Date(anchor.expires_at),
        },
      },
    );
    const later = new Date(Date.parse(anchor.expires_at) + 1000);
    const storeLater = createResultStore({ ...api, clock: () => later });
    // Saved at `later`, so it has 24 hours to go when the job runs.
    const kept = await storeLater.save({ ...input, query_id: randomUUID() }, [
      [7],
    ]);
    const readLater = (result_id = anchor.result_id) =>
      storeLater.read(owner, result_id, { offset: 0, limit: 1 });
    const expired = {
      kind: "not_found",
      message: `This result expired at ${anchor.expires_at}. Its query is ${query_id}: get_query gives its DAX to run again.`,
      detail: { query_id, expired_at: anchor.expires_at },
    };
    await expect(readLater()).rejects.toMatchObject(expired);
    await worker.db.insert(event).values([
      { kind: "sync.finished", at: new Date(later.getTime() - 91 * DAY_MS) },
      { kind: "sync.finished", at: new Date(later.getTime() - 89 * DAY_MS) },
    ]);

    const job = handlerFor("expire_results", "worker");
    if (job === undefined)
      throw new Error("no expire_results job is registered");
    await job.handler({ ...worker, clock: () => later }, {}, "schedule");

    const results = await worker.db
      .select()
      .from(queryResult)
      .where(eq(queryResult.id, anchor.result_id));
    const pages = await worker.db
      .select()
      .from(queryResultPage)
      .where(eq(queryResultPage.result_id, anchor.result_id));
    expect([results, pages]).toEqual([[], []]);
    await expect(readLater()).rejects.toMatchObject(expired);
    await expect(readLater(kept.result_id)).resolves.toMatchObject({
      rows: [[7]],
    });
    const events = await worker.db.select({ at: event.at }).from(event);
    expect(events).toEqual([{ at: new Date(later.getTime() - 89 * DAY_MS) }]);
  });
});
