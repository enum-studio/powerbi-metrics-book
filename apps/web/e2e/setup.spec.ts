import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { SCHEMES, SIZES } from "../playwright.config.ts";
import { appPage, MICROSOFT_LINKS } from "../src/setup/links.ts";
import { devStackUrl, PEOPLE } from "./fixtures.ts";
import { problemsOnPhones, smallTargets } from "./phone.ts";

// Each first run makes an admin, so the two paths run in order on fresh mock stacks.
const DEV_STACK = fileURLToPath(
  new URL("../../../scripts/dev-stack.mjs", import.meta.url),
);

const SAMPLE = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  app: {
    client_id: "c1000000-0000-4000-8000-000000000002",
    secret: "sample-app-secret",
  },
  scanner: {
    client_id: "c1000000-0000-4000-8000-000000000001",
    secret: "sample-scanner-secret",
  },
  admin_object_id: "a0000000-0000-4000-8000-000000000001",
};
const ADMIN_APIS_REFUSED =
  "Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.";
const SETUP_SIZES = [...SIZES, { width: 1024, height: 900 }];
const RUN_MS = 6 * 60_000;

/** The mock publishes the port after the api's (dev-stack.mjs, devIdentity). */
function mockUrl(path: string): string {
  const api = new URL(devStackUrl());
  return `http://localhost:${String(Number(api.port) + 1)}${path}`;
}

async function mock(
  page: Page,
  method: "POST" | "PATCH",
  path: string,
  data: object,
) {
  const response = await page.request.fetch(mockUrl(path), { method, data });
  expect(response.ok(), `${method} ${path}`).toBe(true);
}

/** A new setup link from the api, which ends any earlier one. */
function setupLink(): URL {
  const printed = execFileSync("node", [DEV_STACK, "setup-link"], {
    encoding: "utf8",
  });
  const link = /https?:\/\/\S+#token=\S+/.exec(printed)?.[0];
  if (link === undefined) throw new Error(`No setup link: ${printed}`);
  return new URL(link);
}

const step = (page: Page) => page.getByRole("region", { name: /^Step \d+: / });

async function runCheck(page: Page, button: string) {
  await step(page).getByRole("button", { name: button }).click();
  return step(page).getByRole("status");
}

const guide = (page: Page) =>
  page.getByRole("complementary", { name: "Do this now" });

async function openItem(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect(
    guide(page).getByRole("heading", { level: 3 }).first(),
  ).toHaveText(title);
}

async function guideLinks(page: Page, way: "have" | "make") {
  const links = MICROSOFT_LINKS;
  const items = [
    { title: "Your tenant", count: 2, links: [links.overview] },
    {
      title: "The sign-in app",
      count: 4,
      links: (
        [
          ["Overview", "Open this app's Overview"],
          ["Authentication", "Open this app's Authentication"],
          ["CallAnAPI", "Open this app's API permissions"],
          ["Credentials", "Open this app's Certificates & secrets"],
        ] as const
      ).map(([page, label]) => ({
        label,
        href: appPage(page, SAMPLE.app.client_id),
      })),
    },
    { title: "The scanner app", count: 3, links: [links.appRegistrations] },
    { title: "The scanner's security group", count: 2, links: [links.groups] },
    {
      title: "Three Power BI tenant settings",
      count: 5,
      links: [links.powerBiTenantSettings],
    },
  ];
  for (const viewport of SETUP_SIZES)
    for (const colorScheme of SCHEMES) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      for (const item of items) {
        await openItem(page, item.title);
        const makeApp =
          way === "make" &&
          ["The sign-in app", "The scanner app"].includes(item.title);
        const expectedLinks = makeApp ? [links.newRegistration] : item.links;
        await expect(guide(page).locator("ol > li")).toHaveCount(
          makeApp && item.title === "The sign-in app" ? 5 : item.count,
        );
        await expect(guide(page).getByRole("link")).toHaveCount(
          expectedLinks.length + 1,
        );
        for (const link of expectedLinks) {
          if (link.href === null)
            throw new Error(`Missing address for ${link.label}`);
          const shown = guide(page).getByRole("link", {
            name: link.label,
            exact: true,
          });
          await expect(shown).toBeVisible();
          await expect(shown).toHaveAttribute("href", link.href);
          await expect(shown).toHaveAttribute("target", "_blank");
          await expect(shown).toHaveAttribute("rel", "noopener");
        }
        await expect(
          guide(page).getByRole("link", { name: "Read the full setup guide" }),
        ).toHaveAttribute("href", /^\/docs\/set-up\//);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBe(0);
    }
}

async function firstRun(page: Page, way: "have" | "make") {
  const testInfo = test.info();
  const capture = async (
    screen: string,
    also?: (width: number) => Promise<string[]>,
  ) => {
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("The setup test needs a viewport.");
    const scheme = await page.evaluate(() =>
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    );
    await page.waitForLoadState("networkidle");
    for (const size of SETUP_SIZES)
      for (const colorScheme of SCHEMES) {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme });
        if (screen === "screen-2" && size.width >= 1024) {
          const bounds = await guide(page).boundingBox();
          expect(bounds?.width).toBeGreaterThanOrEqual(340);
          expect(bounds?.width).toBeLessThanOrEqual(360);
          for (const value of await guide(page).locator("code").all())
            await expect(value).toHaveCSS("white-space", "nowrap");
          if (size.width === 1440)
            expect(
              (await page.getByRole("main").boundingBox())?.width,
            ).toBeGreaterThanOrEqual(1180);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(size.width);
        await page.screenshot({
          path: testInfo.outputPath(
            `${screen}-${way}-${String(size.width)}-${colorScheme}.png`,
          ),
          fullPage: true,
        });
      }
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: scheme });
    // Mid-flow, as it stands: the screen at a phone's width on a touch screen.
    expect(await problemsOnPhones(page, also), screen).toEqual([]);
  };
  await test.step("address", async () => {
    await page.goto("/setup");
    await expect(
      page.getByText("docker compose exec api server setup-link"),
    ).toBeVisible();
    const link = setupLink();
    await page.goto(`${link.pathname}${link.hash}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address");
    await expect(
      step(page).getByText(devStackUrl(), { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/setup(\?.*)?$/);
    await expect(await runCheck(page, "Check the address")).toContainText(
      "Passed",
    );
    await page
      .getByRole("link", { name: "Connect your Microsoft tenant", exact: true })
      .click();
  });
  await test.step("tenant lookup and the sign-in app", async () => {
    await page
      .getByRole("radio", {
        name: way === "have" ? "Yes, I have the apps" : "No, starting fresh",
      })
      .click();
    await page.getByLabel("Your work email").fill(PEOPLE.admin);
    await page.getByLabel("Your work email").press("Tab");
    await expect(page.getByRole("status")).toContainText(
      `Found: tenant ${SAMPLE.tenant_id}`,
    );
    await expect(page.getByLabel("Directory (tenant) ID")).toHaveValue(
      SAMPLE.tenant_id,
    );
    await page.getByRole("button", { name: "Next: The sign-in app" }).click();
    await expect(
      page.getByRole("tab", {
        name: way === "have" ? "I have it" : "Make it",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(guide(page).locator("ol > li")).toHaveCount(
      way === "have" ? 4 : 5,
    );
    await page.getByLabel("Application (client) ID").fill(SAMPLE.app.client_id);
    // The guide's links, to the Entra portal and the setup guide, are a finger's size on a phone.
    await capture("screen-2", () =>
      smallTargets(guide(page).getByRole("link")),
    );
    await guideLinks(page, way);
    await openItem(page, "The sign-in app");
    await page.getByLabel("Client secret value").fill(SAMPLE.app.secret);
    await page.getByLabel("The secret expires on").fill("2099-12-31");
    await page
      .getByRole("button", { name: "Check the sign-in app", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^The scanner app/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await openItem(page, "The sign-in app");
    await expect(page.getByRole("status")).toContainText(
      "Checked: this app signs in",
    );
    await expect(page.getByLabel("Client secret value")).toHaveValue("");
    await expect(page.getByLabel("Client secret value")).toHaveAttribute(
      "placeholder",
      "*****",
    );
    await page.getByRole("button", { name: "Next: The scanner app" }).click();
  });
  await test.step("the scanner, its group and tenant settings", async () => {
    await expect(guide(page).locator("ol > li")).toHaveCount(3);
    await page
      .getByLabel("Application (client) ID")
      .fill(SAMPLE.scanner.client_id);
    const value = page.getByLabel("Client secret value");
    await expect(value).toHaveAttribute("autocomplete", "new-password");
    await expect(page.locator("form")).toHaveAttribute("autocomplete", "off");
    for (const ignored of ["data-1p-ignore", "data-lpignore", "data-bwignore"])
      await expect(value).toHaveAttribute(ignored);
    await openItem(page, "The scanner's security group");
    await expect(guide(page).locator("ol > li")).toHaveCount(2);
    await openItem(page, "Three Power BI tenant settings");
    await expect(guide(page).locator("ol > li")).toHaveCount(5);
    await openItem(page, "The scanner app");
    await value.fill(SAMPLE.scanner.secret);
    await page.getByLabel("The secret expires on").fill("2099-12-31");
    await mock(page, "PATCH", "/_mock/settings", {
      service_principals_admin_apis: false,
    });
    try {
      // The scanner app's check is only a token, which this setting does not touch.
      await page
        .getByRole("button", { name: "Check the scanner app", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: /^The scanner's security group/ }),
      ).toHaveAttribute("aria-expanded", "true", { timeout: 100_000 });
      await expect(
        page.getByRole("button", { name: /^The scanner app/ }),
      ).toContainText("Checked");
      // The full check, from the tenant settings, is what finds the refusal.
      await openItem(page, "Three Power BI tenant settings");
      await page
        .getByRole("button", { name: "Check the scanner", exact: true })
        .click();
      await expect(
        page.getByRole("alert").filter({ hasText: ADMIN_APIS_REFUSED }),
      ).toBeVisible({ timeout: 100_000 });
      await capture("failed-check");
      await openItem(page, "The scanner's security group");
      await expect(
        page.getByRole("alert").filter({ hasText: ADMIN_APIS_REFUSED }),
      ).toBeVisible();
    } finally {
      await mock(page, "PATCH", "/_mock/settings", {
        service_principals_admin_apis: true,
      });
    }
    await openItem(page, "Three Power BI tenant settings");
    await page
      .getByRole("button", { name: "Check the scanner", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your tenant is connected" }),
    ).toBeVisible({ timeout: 100_000 });
    // Every item is done now, so the guide has moved on to signing in.
    await page.getByRole("button", { name: /^The scanner app/ }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Checked: the scanner signs in" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Next: The scanner's security group" }),
    ).toBeVisible();
    for (const callback of [
      "/api/auth/callback/microsoft",
      "/api/v1/powerbi/callback",
    ])
      await expect(
        page.getByText(`${devStackUrl()}${callback}`, { exact: true }).first(),
      ).toBeVisible();
    await page
      .getByRole("link", { name: "Continue: sign in with Microsoft" })
      .click();
  });
  await test.step("Microsoft sign-in, confirm, then the Power BI connection", async () => {
    await mock(page, "POST", "/_mock/acting-user", {
      object_id: SAMPLE.admin_object_id,
    });
    await capture("screen-3");
    await page
      .getByRole("button", { name: "Sign in with Microsoft", exact: true })
      .click();
    await expect(
      page.getByText(`Signed in as`, { exact: false }),
    ).toContainText(PEOPLE.admin);
    const connected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/powerbi/callback",
    );
    await page.getByRole("button", { name: "Make me the admin" }).click();
    expect((await connected).status()).toBe(302);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "What to sync",
    );
  });
  await test.step("workspaces, Start, then done", async () => {
    const personal = page.getByRole("checkbox", {
      name: "Personal workspaces",
      exact: true,
    });
    await expect(personal).toBeVisible({ timeout: 100_000 });
    await expect(personal).not.toBeChecked();
    await expect(
      page.getByText("1 personal workspace, not synced", { exact: true }),
    ).toBeVisible();
    await personal.check();
    await expect(
      page.getByRole("checkbox", {
        name: "My workspace (Analyst) Personal",
        exact: true,
      }),
    ).toBeChecked({ timeout: 100_000 });
    const boxes = page
      .getByRole("group", { name: "Workspaces" })
      .getByRole("checkbox");
    expect(await boxes.count()).toBeGreaterThan(1);
    for (const box of await boxes.all()) await expect(box).toBeChecked();
    await capture("screen-4");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Who gets in" }),
    ).toBeVisible({
      timeout: 100_000,
    });
    await capture("people");
    await page
      .getByRole("button", { name: "Continue: connect your agent" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Connect your agent" }),
    ).toBeVisible();
    await capture("agent");
    await page.getByRole("link", { name: "Skip for now" }).click();
    await expect(
      page.getByRole("heading", {
        name: /^The (first sync is running|setup is done)$/,
      }),
    ).toBeVisible();
    await capture("done");
    await page
      .getByRole("link", { name: "Start using the app" })
      .click({ timeout: 100_000 });
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search the catalog" }),
    ).toBeVisible();
    await capture("home");
  });
}

test.describe.configure({ mode: "serial" });

test("a link whose session fails to open leaves no token in the address", async ({
  page,
}) => {
  await page.route("**/api/setup/session", (route) => route.abort());
  const sent = page.waitForRequest("**/api/setup/session");
  await page.goto("/setup#token=sample-token-never-sent");
  await sent;
  await expect(page).toHaveURL(/\/setup$/);
});

for (const way of ["make", "have"] as const)
  test(`the first run by ${way === "make" ? "Make it" : "I have it"} reaches done`, async ({
    page,
  }) => {
    test.setTimeout(RUN_MS);
    if (way === "have") {
      for (const args of [["reset"], ["up", "--no-setup"]])
        execFileSync("node", [DEV_STACK, ...args], { stdio: "inherit" });
    }
    await firstRun(page, way);
  });
