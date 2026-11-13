import { describe, expect, it } from "vitest";
import { formatTime } from "./time";

const MOMENT = "2026-10-26T20:31:00Z";

describe("formatTime", () => {
  it("shows the viewer's local time with their zone's abbreviation", () => {
    expect(
      formatTime(MOMENT, { locale: "en-GB", timeZone: "Europe/Copenhagen" }),
    ).toBe("26 Oct 2026, 21:31 CET");
    expect(formatTime(MOMENT, { locale: "en-GB", timeZone: "UTC" })).toBe(
      "26 Oct 2026, 20:31 UTC",
    );
  });

  it("follows summer time", () => {
    expect(
      formatTime("2026-07-01T10:00:00Z", {
        locale: "en-GB",
        timeZone: "Europe/Copenhagen",
      }),
    ).toBe("1 Jul 2026, 12:00 CEST");
  });
});
