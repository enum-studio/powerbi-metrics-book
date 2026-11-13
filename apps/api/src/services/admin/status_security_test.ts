import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createDb } from "../../db/client.js";
import { syncRun } from "../../db/schema/mirror.js";
import { adminStatus } from "./status.js";

afterAll(closeTestPools);

const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = { ...deps, principal: principals.admin };
const worker = createDb(testPool("worker_rw"));
const reader = {
  ...deps,
  access: cerbosAccess(new MemorySettings(), "override"),
  principal: {
    ...principals.admin,
    kind: "service_account" as const,
    roles: ["integration"],
  },
};
const ERROR = "Workspace 7 could not be scanned, so it was left as it was.";

const run = (
  kind: "full" | "incremental",
  status: "running" | "succeeded" | "failed" | "skipped",
  started_at: string,
) => ({
  kind,
  status,
  trigger: "schedule" as const,
  started_at: new Date(started_at),
  finished_at: status === "running" ? null : new Date(started_at),
  error: status === "failed" ? ERROR : null,
});

const failedFull = run("full", "failed", "2026-11-04T02:30:00Z");
const fullSyncLine = async () =>
  (await adminStatus(admin)).failing_checks.find(
    (check) => check.name === "full_sync",
  );

beforeEach(async () => {
  await createDb(testPool("migrator")).delete(syncRun);
});

describe("a full sync that failed", () => {
  it("stays listed through the incremental syncs after it, in a fixed sentence", async () => {
    await worker
      .insert(syncRun)
      .values([
        failedFull,
        run("incremental", "succeeded", "2026-11-04T03:00:00Z"),
        run("full", "skipped", "2026-11-04T03:05:00Z"),
        run("incremental", "skipped", "2026-11-04T03:10:00Z"),
      ]);
    const status = await adminStatus(admin);
    expect(status.last_sync).toMatchObject({ kind: "incremental" });
    const line = status.failing_checks.find((c) => c.name === "full_sync");
    expect(line).toMatchObject({
      message: expect.stringContaining(
        "The full sync of 2026-11-04 failed.",
      ) as string,
      checked_at: failedFull.finished_at,
    });
    expect(JSON.stringify(line)).not.toContain(ERROR);
  });

  it("stays listed while a newer full sync runs", async () => {
    await worker
      .insert(syncRun)
      .values([failedFull, run("full", "running", "2026-11-05T02:30:00Z")]);
    expect(await fullSyncLine()).toBeDefined();
  });

  it("goes once a newer full sync succeeds", async () => {
    await worker
      .insert(syncRun)
      .values([failedFull, run("full", "succeeded", "2026-11-05T02:30:00Z")]);
    expect(await fullSyncLine()).toBeUndefined();
  });

  it("is not told by an incremental sync that failed", async () => {
    await worker
      .insert(syncRun)
      .values([
        run("full", "succeeded", "2026-11-04T02:30:00Z"),
        run("incremental", "failed", "2026-11-04T03:00:00Z"),
      ]);
    expect(await fullSyncLine()).toBeUndefined();
  });

  it("is a name alone to a read-only caller", async () => {
    await worker.insert(syncRun).values(failedFull);
    const read = await adminStatus(reader);
    expect(read.failing_checks).toContainEqual({ name: "full_sync" });
    expect(JSON.stringify(read)).not.toContain(ERROR);
  });
});
