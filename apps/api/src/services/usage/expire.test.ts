import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { request, searchLog } from "../../db/schema/usage.js";
import "../jobs/all.js";
import { handlerFor } from "../jobs/registry.js";

const deps = createTestDeps({ container: "worker" });
const principalId = randomUUID();
afterAll(async () => {
  for (const table of [request, searchLog]) {
    await deps.db.delete(table).where(eq(table.principal_id, principalId));
  }
  await closeTestPools();
});

async function seed(days: number) {
  const row = {
    id: randomUUID(),
    at: new Date(deps.clock().getTime() - days * 86_400_000),
    principal_kind: "person" as const,
    principal_id: principalId,
    via: "mcp" as const,
  };
  await deps.auditDb.insert(request).values({
    ...row,
    question: "Sample retention question",
    outcome: "answered",
  });
  await deps.auditDb.insert(searchLog).values({
    ...row,
    query: "Sample search",
    search_mode: "words_only",
    hit_count: 0,
    metric_hit: false,
  });
  return row.id;
}

async function expire() {
  const job = handlerFor("expire_usage", "worker");
  expect(job?.runner).toBe("worker");
  if (job === undefined) throw new Error("expire_usage is missing");
  await job.handler(deps, {}, "schedule");
}

async function remaining(kept: string) {
  for (const table of [request, searchLog]) {
    const rows = await deps.db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.principal_id, principalId));
    expect(rows.map((row) => row.id)).toEqual([kept]);
  }
}
it("expires a request 181 days old and keeps one 179 days old by default", async () => {
  const log = vi.spyOn(deps.logger, "info");
  await seed(181);
  const kept = await seed(179);
  await expire();
  await remaining(kept);
  expect(log).toHaveBeenCalledWith("old requests and searches deleted", {
    requests: 1,
    searches: 1,
  });
  log.mockRestore();
});

it("reads a lowered retention setting on the next run", async () => {
  await seed(60);
  const kept = await seed(10);
  await expire();
  await deps.settings.set("usage.retention_days", 30, principals.admin);
  await expire();
  await remaining(kept);
});
