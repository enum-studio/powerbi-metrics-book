import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testPool,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createDb } from "../../db/client.js";
import { jobRequest } from "../../db/schema/jobs.js";
import { createLogger } from "../../log.js";
import { startSchedule } from "./schedule.js";

// The api runner's refresh_idle_connections job is this file's alone: test
// files share one database and run in parallel.
const MINE = and(
  eq(jobRequest.runner, "api"),
  eq(jobRequest.job, "refresh_idle_connections"),
);

async function clearJobs(): Promise<void> {
  await createDb(testPool("migrator")).delete(jobRequest).where(MINE);
}

/** A wait in real time, which the cron lines run on; only the minute between reads of the settings is faked. */
function realWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(clearJobs);
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await clearJobs();
  await closeTestPools();
});

describe("startSchedule", () => {
  it("enqueues the entry's job with trigger schedule when its cron line fires", async () => {
    const deps = createTestDeps({
      settings: new MemorySettings({ "powerbi.sync.schedule": "* * * * * *" }),
    });
    const schedule = await startSchedule(deps, [
      {
        job: "refresh_idle_connections",
        runner: "api",
        args: { unused_days: 30 },
        cron: { setting: "powerbi.sync.schedule" },
      },
    ]);
    // Every second; a loaded machine can delay the firing or its insert.
    const queued = await vi.waitFor(
      async () => {
        const rows = await deps.db.select().from(jobRequest).where(MINE);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        return rows;
      },
      { timeout: 5_000, interval: 100 },
    );
    schedule.stop();
    expect(queued[0]).toMatchObject({
      status: "queued",
      trigger: "schedule",
      args: { unused_days: 30 },
      requested_by: null,
    });
  });

  it("fails at start, naming the setting, when a cron line does not parse", async () => {
    const deps = createTestDeps({
      settings: new MemorySettings({
        "powerbi.sync.full_scan_schedule": "every night",
      }),
    });
    await expect(
      startSchedule(deps, [
        { job: "refresh_idle_connections", runner: "api", cron: "0 3 * * *" },
        {
          job: "refresh_idle_connections",
          runner: "api",
          cron: { setting: "powerbi.sync.full_scan_schedule" },
        },
      ]),
    ).rejects.toThrow(
      /^the setting powerbi\.sync\.full_scan_schedule is "every night", which is not a cron line/,
    );
  });

  it("reads a setting's cron line again every minute, and keeps the last good one when a new one does not parse", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const log: string[] = [];
    const settings = new MemorySettings({
      "powerbi.sync.schedule": "0 0 1 1 *",
    });
    const deps = createTestDeps({
      settings,
      logger: createLogger("warn", (line) => log.push(line)),
    });
    const queued = async () =>
      (await deps.db.select().from(jobRequest).where(MINE)).length;
    // Every firing begins with this insert, however long its row takes to land.
    const insert = vi.spyOn(deps.db, "insert");
    const started = () => insert.mock.calls.length;
    // A loaded machine can delay a firing or its insert by seconds.
    const landing = { timeout: 20_000, interval: 100 };
    const schedule = await startSchedule(deps, [
      {
        job: "refresh_idle_connections",
        runner: "api",
        cron: { setting: "powerbi.sync.schedule" },
      },
    ]);
    onTestFinished(() => {
      schedule.stop();
    });

    await settings.set("powerbi.sync.schedule", "* * * * * *");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      expect(await queued()).toBeGreaterThanOrEqual(1);
    }, landing);

    await settings.set("powerbi.sync.schedule", "every night");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        level: "error",
        setting: "powerbi.sync.schedule",
      }),
    ]);
    expect(log.join("\n")).not.toContain("every night");
    // More rows than firings so far: one that started after the refused line.
    const beforeRefusal = started();
    await vi.waitFor(async () => {
      expect(await queued()).toBeGreaterThan(beforeRefusal);
    }, landing);

    await settings.set("powerbi.sync.schedule", "0 0 1 1 *");
    await vi.advanceTimersByTimeAsync(60_000);
    // A firing already under way may still land; none may start. A delay can
    // only hide a late firing here, never invent one.
    const last = started();
    await realWait(1300);
    expect(started()).toBe(last);
  }, 60_000);
});
