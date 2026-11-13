import { expect, it } from "vitest";
import { item, ITEMS } from "./items";
import { appPage, MICROSOFT_LINKS, type AppPage } from "./links";

const ORIGIN = "https://book.example.com:8443";
const GUID = "3f2b8c1e-7d4a-4e0b-9c61-2a5d8e9f0b17";
const PAGES: AppPage[] = [
  "Overview",
  "Authentication",
  "Credentials",
  "CallAnAPI",
];

it.each([GUID, "abc", null])("links the sign-in guide for %s", (id) => {
  const steps = item("sign_in_app", ORIGIN, id).guide.have;
  const own = (page: AppPage, label: string) => [
    { label, href: appPage(page, GUID) },
  ];
  expect(steps.map((step) => step.links)).toEqual(
    id === GUID
      ? [
          own("Overview", "Open this app's Overview"),
          own("Authentication", "Open this app's Authentication"),
          own("CallAnAPI", "Open this app's API permissions"),
          own("Credentials", "Open this app's Certificates & secrets"),
        ]
      : [[MICROSOFT_LINKS.appRegistrations], [], [], []],
  );
});

it("builds copies from the deployment origin", () => {
  const signIn = item("sign_in_app", ORIGIN, null);
  const copies = (way: "have" | "make") =>
    signIn.guide[way].flatMap((step) => step.copies);
  expect(copies("have").map((copy) => copy.value)).toEqual([
    `${ORIGIN}/api/auth/callback/microsoft`,
    `${ORIGIN}/api/v1/powerbi/callback`,
  ]);
  expect(copies("make").map((copy) => copy.value)).toEqual([
    "Power BI Metrics Book (book.example.com:8443)",
    `${ORIGIN}/api/auth/callback/microsoft`,
    `${ORIGIN}/api/v1/powerbi/callback`,
  ]);
});

it("keeps the five items ordered and gives tenant and settings their ways", () => {
  expect(ITEMS).toEqual([
    "tenant",
    "sign_in_app",
    "scanner_app",
    "scanner_group",
    "tenant_settings",
  ]);
  const tenant = item("tenant", ORIGIN, null);
  expect(tenant.ways).toBeNull();
  expect(tenant.guide.have).toEqual(tenant.guide.make);
  const settings = item("tenant_settings", ORIGIN, null);
  expect(settings.ways).toEqual({ have: "They are on", make: "Turn them on" });
  expect(settings.guide.have).toEqual(settings.guide.make);
  expect(
    settings.guide.have
      .map((step) => step.text.match(/^"([^"]+)"/)?.[1])
      .filter(Boolean),
  ).toEqual([
    "Service principals can access read-only admin APIs",
    "Enhance admin APIs responses with detailed metadata",
    "Enhance admin APIs responses with DAX and mashup expressions",
  ]);
});

it.each([GUID, "abc", null])(
  "uses only fixed or checked app links and plain punctuation for %s",
  (clientId) => {
    const allowed = new Set([
      ...Object.values(MICROSOFT_LINKS).map((link) => link.href),
      ...PAGES.map((page) => appPage(page, GUID)),
    ]);
    for (const id of ITEMS) {
      const value = item(id, ORIGIN, clientId);
      expect(value.id).toBe(id);
      expect(
        JSON.stringify({
          ...value,
          summary: value.summary("book.example.com"),
        }),
      ).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d]/u);
      for (const step of [...value.guide.have, ...value.guide.make]) {
        for (const link of step.links)
          expect(allowed.has(link.href)).toBe(true);
      }
    }
  },
);

it("gives every item its short guide ledes", () => {
  expect(ITEMS.map((id) => item(id, ORIGIN, GUID).lede.make)).toEqual([
    "",
    "About 8 minutes. Keep this page in one tab and Entra in another.",
    "About 3 minutes.",
    "About 2 minutes.",
    "In the Power BI admin portal, as a Fabric Administrator. About 4 minutes, then up to 15 for Microsoft.",
  ]);
  expect(item("tenant_settings", ORIGIN, GUID).lede.have).toBe(
    "You are a Fabric Administrator if you can open this page. Check each one against this list.",
  );
});

it.each([GUID, "abc", null])(
  "shows the sign-in app lede only for its own valid ID: %s",
  (id) => {
    expect(item("sign_in_app", ORIGIN, id).lede.have).toBe(
      id === GUID
        ? "The links now open your own app, from the client ID you pasted."
        : "",
    );
  },
);

it.each(["sign_in_app", "scanner_app"] as const)(
  "uses the current registration labels for %s",
  (id) => {
    const text = item(id, ORIGIN, GUID).guide.make[0]?.text;
    expect(text).toContain(
      "Select Open New registration in Entra. The page is titled Register an application. Paste the name.",
    );
    expect(text).toContain(
      "Leave Supported account types on Single tenant only",
    );
  },
);

it("gives the scanner its own secret and group", () => {
  expect(
    item("scanner_app", ORIGIN, GUID)
      .guide.have.map((step) => step.text)
      .join(" "),
  ).toContain("Do not reuse a secret another tool uses");
  expect(
    item("scanner_group", ORIGIN, GUID)
      .guide.have.map((step) => step.text)
      .join(" "),
  ).toContain("the group holds only this scanner app");
});
