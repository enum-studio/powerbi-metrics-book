import { describe, expect, it } from "vitest";
import { nextRun, nextRunInWords } from "./cron";

const NOW = new Date("2026-10-26T14:20:30Z");

describe("nextRun", () => {
  it("finds the next hour for the default incremental line", () => {
    expect(nextRun("0 * * * *", NOW)?.toISOString()).toBe(
      "2026-10-26T15:00:00.000Z",
    );
  });

  it("finds tomorrow for the default full scan, and never the current minute", () => {
    expect(nextRun("30 2 * * *", NOW)?.toISOString()).toBe(
      "2026-10-27T02:30:00.000Z",
    );
    expect(nextRun("20 14 * * *", NOW)?.toISOString()).toBe(
      "2026-10-27T14:20:00.000Z",
    );
  });

  it("reads steps, lists, ranges and weekdays", () => {
    expect(nextRun("*/15 * * * *", NOW)?.toISOString()).toBe(
      "2026-10-26T14:30:00.000Z",
    );
    expect(nextRun("0 6,18 * * 1-5", NOW)?.toISOString()).toBe(
      "2026-10-26T18:00:00.000Z",
    );
    expect(nextRun("0 6 * * 0", NOW)?.toISOString()).toBe(
      "2026-11-01T06:00:00.000Z",
    );
  });

  it("answers null for a line it cannot read", () => {
    expect(nextRun("every hour", NOW)).toBeNull();
    expect(nextRun("61 * * * *", NOW)).toBeNull();
    expect(nextRun("0 * * *", NOW)).toBeNull();
  });
});

describe("nextRunInWords", () => {
  it("says how long, when in UTC, which cron runs in, and when for the viewer", () => {
    expect(nextRunInWords("30 2 * * *", NOW, "Europe/Copenhagen")).toBe(
      "Next run in 12 hours, Tue 27 Oct at 02:30 UTC (Tue 03:30 CET for you).",
    );
  });

  it("does not say it twice for a viewer on UTC", () => {
    expect(nextRunInWords("30 2 * * *", NOW, "UTC")).toBe(
      "Next run in 12 hours, Tue 27 Oct at 02:30 UTC.",
    );
  });
});
