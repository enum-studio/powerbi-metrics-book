import { randomUUID } from "node:crypto";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import {
  changed,
  contextAs,
  devStackUrl,
  expect,
  forget,
  getJson,
  grantRole,
  PEOPLE,
  test,
} from "./fixtures.ts";

const retail = "/catalog/datasets/d1000000-0000-4000-8000-000000000005";
const sales = "/catalog/datasets/d1000000-0000-4000-8000-000000000001";

let createdRule = false;

test.beforeAll(async ({ browser }) => {
  const admin = await contextAs(browser, "admin");
  try {
    const response = await admin.request.put("/api/v1/admin/pii/rules", {
      headers: { origin: devStackUrl() },
      data: {
        kind: "column",
        table: "Customer",
        name: "Customer",
        pii: true,
        expected_version: null,
      },
    });
    expect([200, 409]).toContain(response.status());
    createdRule = response.ok();
  } finally {
    await admin.close();
  }
});

test.afterAll(async ({ browser }) => {
  const admin = await contextAs(browser, "admin");
  try {
    const page = await admin.newPage();
    await page.goto("/admin/pii");
    await expect(page.getByRole("region", { name: /^Rules/ })).toBeVisible();
    for (const name of createdRule ? ["Customer"] : []) {
      const rule = page
        .getByRole("listitem")
        .filter({ hasText: `'Customer'[${name}]` });
      if (await rule.count()) {
        await rule.getByRole("button", { name: "Remove", exact: true }).click();
      }
      await expect(rule).toHaveCount(0);
    }
  } finally {
    await admin.close();
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      document.documentElement.dataset.cspViolation = event.violatedDirective;
    });
  });
});
test.afterEach(async ({ page }) => {
  await expect(page.locator("html")).not.toHaveAttribute("data-csp-violation");
});
const panelOf = (page: Page) =>
  page.locator("aside").filter({
    has: page.getByRole("heading", { name: "Customer", exact: true }),
  });
const columnOf = (page: Page, name: string) =>
  panelOf(page)
    .locator("p.group")
    .filter({
      has: page.getByText(name, { exact: true }),
    });

test.describe("a viewer without pii_reader @tenant", () => {
  test.use({ signedInAs: "viewer" });
  for (const [name, path] of [
    ["Sales", sales],
    ["Retail", retail],
  ] as const) {
    test(`Customer in ${name} shows only the hidden PII count`, async ({
      page,
    }) => {
      await page.goto(`${path}?tab=diagram&table=Customer`);
      await expect(
        panelOf(page).getByText("1 column hidden as PII.", { exact: true }),
      ).toBeVisible();
      await expect(
        panelOf(page).locator("p").getByText("Customer", { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Mark PII" })).toHaveCount(
        0,
      );
      expect(
        (
          await page.request.put("/api/v1/admin/pii/rules", {
            headers: { origin: devStackUrl() },
            data: {
              kind: "column",
              table: "Customer",
              name: "Segment",
              pii: true,
            },
          })
        ).status(),
      ).toBe(403);
    });
  }
});

/**
 * No admin gives themselves pii_reader or takes it away, so an admin made for
 * the run does it, and leaves with its user and roles after.
 */
async function asAnotherAdmin(
  browser: Browser,
  work: (request: APIRequestContext) => Promise<void>,
): Promise<void> {
  const email = `pii-granter-${randomUUID().slice(0, 8)}@sample.example`;
  const admin = await contextAs(browser, "admin");
  const other = await browser.newContext({ baseURL: devStackUrl() });
  try {
    await grantRole(admin.request, email, "admin");
    const signedIn = await other.request.post("/api/auth/dev/sign-in", {
      headers: { origin: devStackUrl() },
      data: { email },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    await work(other.request);
  } finally {
    await other.close();
    await forget(admin.request, email);
    await admin.close();
  }
}

// Granting pii_reader changes the shared admin; these tests run after the other projects.
for (const width of [390, 1440])
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`an admin at ${String(width)} in ${colorScheme} @tenant`, () => {
      test.use({
        signedInAs: "admin",
        viewport: { width, height: 900 },
        colorScheme,
      });
      let grantedRole = false;
      test.beforeAll(async ({ browser }) => {
        await asAnotherAdmin(browser, async (request) => {
          const granted = await request.post("/api/v1/admin/roles", {
            headers: { origin: devStackUrl() },
            data: {
              role: "pii_reader",
              subject_kind: "person",
              subject: PEOPLE.admin,
            },
          });
          expect([201, 409], await granted.text()).toContain(granted.status());
          grantedRole = granted.status() === 201;
        });
      });
      test.afterAll(async ({ browser }) => {
        if (!grantedRole) return;
        await asAnotherAdmin(browser, async (request) => {
          const { roles } = await getJson<{
            roles: { id: string; role: string; subject: string | null }[];
          }>(request, "/api/v1/admin/roles");
          const given = roles.find(
            (each) =>
              each.role === "pii_reader" && each.subject === PEOPLE.admin,
          );
          if (given === undefined)
            throw new Error(`pii_reader for ${PEOPLE.admin} is gone already`);
          await changed(request, "delete", `/api/v1/admin/roles/${given.id}`);
        });
      });
      test("the sample tag links to PII and Mark PII follows focus and hover", async ({
        page,
      }) => {
        await page.goto(`${retail}?tab=diagram&table=Customer`);
        await expect(
          columnOf(page, "Customer").getByRole("link", { name: "PII" }),
        ).toHaveAttribute("href", "/admin/pii");
        const segment = columnOf(page, "Segment");
        const mark = segment.getByRole("button", { name: "Mark PII" });
        await page.mouse.move(0, 0);
        await expect(mark).toHaveCSS("opacity", "0");
        await mark.focus();
        await expect(mark).toHaveCSS("opacity", "1");
        await page.keyboard.press("Tab");
        await segment.hover();
        await expect(mark).toHaveCSS("opacity", "1");
      });
      test("a refused mark shows the API message and leaves Segment untagged", async ({
        page,
      }) => {
        await page.goto(`${retail}?tab=diagram&table=Customer`);
        await page.route("**/api/v1/admin/pii/rules", async (route) => {
          expect(route.request().postDataJSON()).toEqual({
            kind: "column",
            table: "Customer",
            name: "Segment",
            pii: true,
          });
          await route.fulfill({
            status: 403,
            json: {
              error: "refused",
              message: "Your role cannot change PII rules.",
            },
          });
        });
        const segment = columnOf(page, "Segment");
        await segment.getByRole("button", { name: "Mark PII" }).focus();
        await page.keyboard.press("Enter");
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: "Your role cannot change PII rules." }),
        ).toBeVisible();
        await expect(segment.getByText("PII", { exact: true })).toHaveCount(0);
      });

      test("Mark PII tags Segment and Undo deletes that rule @tenant", async ({
        page,
      }) => {
        await page.goto(`${retail}?tab=diagram&table=Customer`);
        const segment = columnOf(page, "Segment");
        const mark = segment.getByRole("button", { name: "Mark PII" });
        await mark.focus();
        const response = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            response.url().endsWith("/admin/pii/rules"),
        );
        await page.keyboard.press("Enter");
        const savedResponse = await response;
        expect(savedResponse.ok()).toBe(true);
        expect(savedResponse.request().postDataJSON()).toEqual({
          kind: "column",
          table: "Customer",
          name: "Segment",
          pii: true,
        });
        const saved: unknown = await savedResponse.json();
        if (
          typeof saved !== "object" ||
          saved === null ||
          !("before" in saved) ||
          !("rule" in saved) ||
          typeof saved.rule !== "object" ||
          saved.rule === null ||
          !("id" in saved.rule) ||
          typeof saved.rule.id !== "string" ||
          !("set_via" in saved.rule) ||
          !("columns" in saved) ||
          typeof saved.columns !== "number" ||
          !("datasets" in saved) ||
          typeof saved.datasets !== "number"
        )
          throw new Error("Missing PII rule coverage");
        try {
          expect(saved.rule.set_via).toBe("browser");
          await expect(
            segment.getByRole("link", { name: "PII" }),
          ).toBeVisible();
          const notice = page
            .getByRole("status")
            .filter({ hasText: "'Customer'[Segment] is PII" });
          await expect(notice).toContainText(
            `'Customer'[Segment] is PII in ${String(saved.columns)} columns of ${String(saved.datasets)} datasets you can reach. People without pii_reader no longer see it.`,
          );
          await notice.getByRole("button", { name: "Undo" }).click();
          await expect(mark).toBeEnabled();
          await expect(segment.getByText("PII", { exact: true })).toHaveCount(
            0,
          );
        } finally {
          const removed =
            saved.before === null &&
            (await page.request.delete(
              `/api/v1/admin/pii/rules/${saved.rule.id}`,
              { headers: { origin: devStackUrl() } },
            ));
          if (removed) expect([204, 404]).toContain(removed.status());
        }
      });
    });
  }
