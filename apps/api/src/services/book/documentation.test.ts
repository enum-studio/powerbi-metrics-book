import { afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestPools } from "../../../test/deps.js";
import { inSampleMirror } from "../../../test/sample-mirror.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import { bookChange, metric } from "../../db/schema/book.js";
import { createMetric, updateMetric, metricChecks } from "./metrics.js";

afterAll(closeTestPools);

it("stores documentation as columns and records every change", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const context = asPerson(reaching({}, "curator"), { db });
    const created = await createMetric(context, {
      name: "number_of_orders",
      label: "Number of orders",
    });
    const fields = {
      tier: "driver",
      importance: "high",
      importance_why: "Orders sustain sales.",
      direction: "higher_is_better",
      use_for: "Plan fulfilment.",
      dont_use_for: "Revenue; use net sales.",
      caveats: "Cancelled orders are excluded.",
      decisions: "Operations plans capacity.",
      actions: "Check channel demand.",
      primary_dimensions: [],
      owner_team: "Operations",
      building_block: false,
    };
    expect(await updateMetric(context, created.id, fields)).toMatchObject(
      fields,
    );
    const changes = await db
      .select()
      .from(bookChange)
      .where(eq(bookChange.element_id, created.id));
    expect(changes.at(-1)?.after).toMatchObject(fields);
    const checks = await metricChecks(context, created.id);
    expect(checks.filter((c) => !c.passed).map((c) => c.rule)).not.toContain(
      "metric_fields.importance_why",
    );
    await expect(
      db
        .update(metric)
        .set({ tier: "made_up" })
        .where(eq(metric.id, created.id)),
    ).rejects.toThrow();
  });
});
