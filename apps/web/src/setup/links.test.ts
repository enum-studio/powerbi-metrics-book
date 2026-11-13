import { describe, expect, it } from "vitest";
import { appPage, MICROSOFT_LINKS } from "./links";

const GUID = "3f2b8c1e-7d4a-4e0b-9c61-2a5d8e9f0b17";

describe("appPage", () => {
  it.each(["not-a-guid", `${GUID}/`, `${GUID}#`, `${GUID} `, `${GUID}\n`])(
    "refuses %j",
    (id) => {
      expect(appPage("Authentication", id)).toBeNull();
    },
  );
  it.each([GUID, GUID.toUpperCase()])("opens Authentication for %s", (id) => {
    expect(appPage("Authentication", id)).toBe(
      `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Authentication/appId/${id}`,
    );
  });
});

it("keeps every fixed link on Microsoft's portals", () => {
  expect(Object.keys(MICROSOFT_LINKS)).toHaveLength(5);
  for (const link of Object.values(MICROSOFT_LINKS)) {
    expect(link.href).toMatch(
      /^https:\/\/(entra\.microsoft\.com|app\.powerbi\.com)\//,
    );
  }
});
