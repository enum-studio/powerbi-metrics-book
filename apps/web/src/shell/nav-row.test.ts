import { describe, expect, it } from "vitest";
import { indent, inSettingsPage } from "./nav-row";

describe("Settings' pages", () => {
  it("are a person's own under /settings and the admin's under /admin", () => {
    for (const path of [
      "/settings/connections",
      "/admin/powerbi",
      "/admin/people",
    ])
      expect(inSettingsPage(path)).toBe(true);
  });

  it("leave out Status, which is a place of the first lane, and every other page", () => {
    for (const path of ["/admin", "/", "/catalog", "/catalog/terms"])
      expect(inSettingsPage(path)).toBe(false);
  });
});

describe("a row's indent", () => {
  it("steps 12px a level, and passes the arrow's place on a row with none", () => {
    expect(indent(0)).toEqual({ paddingLeft: "calc(8px + 0px)" });
    expect(indent(2)).toEqual({ paddingLeft: "calc(8px + 24px)" });
    expect(indent(1, false)).toEqual({
      paddingLeft: "calc(8px + 12px + var(--arrow-place))",
    });
  });
});
