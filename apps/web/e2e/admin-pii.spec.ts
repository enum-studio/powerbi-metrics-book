import { contextAs, devStackUrl, expect, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

const wholeTable = "PII admin fixture";
const createdRules = new Set<string>();

test.afterAll(async ({ browser }) => {
  const admin = await contextAs(browser, "admin");
  try {
    const page = await admin.newPage();
    await page.goto("/admin/pii");
    await expect(page.getByRole("region", { name: /^Rules/ })).toBeVisible();
    for (const reference of createdRules) {
      const rule = page.getByRole("listitem").filter({ hasText: reference });
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

// These writes affect the shared sample tenant, so they run after the size projects.
test("marking Customer[Phone] from Suggestions lists a rule set in the browser @tenant", async ({
  page,
}) => {
  await page.goto("/admin/pii");
  const suggestion = page
    .getByRole("region", { name: /^Suggestions/ })
    .getByRole("row")
    .filter({ hasText: "'Customer'[Phone]" });
  await expect(suggestion).toContainText("Retail");
  createdRules.add("'Customer'[Phone]");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith("/admin/pii/rules"),
  );
  await suggestion
    .getByRole("button", { name: "Mark PII", exact: true })
    .click();
  expect((await sent).postDataJSON()).toEqual({
    kind: "column",
    table: "Customer",
    name: "Phone",
    pii: true,
  });
  const rule = page
    .getByRole("listitem")
    .filter({ hasText: "'Customer'[Phone]" });
  try {
    await expect(rule).toContainText(
      /Set by admin@sample.example in the browser,/,
    );
    await expect(rule).toContainText(
      /Covers \d+ columns in \d+ datasets you can reach/,
    );
    await expect(suggestion).toHaveCount(0);
    await page
      .getByRole("status")
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(suggestion).toBeVisible();
    await expect(rule).toHaveCount(0);
  } finally {
    if (await rule.count()) {
      await rule.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(rule).toHaveCount(0);
    }
  }
});

test("PII explains rules and reach with no page overflow", async ({ page }) => {
  await page.goto("/admin/pii");
  await expect(
    page.getByRole("heading", { name: "PII", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Users and roles", exact: true }).last(),
  ).toHaveAttribute("href", "/admin/people");
  await expect(page.getByText("In datasets you can reach.")).toBeVisible();
  await page.getByRole("button", { name: "Add a rule", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Column", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "A measure", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Measure", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a viewer opening PII gets the admin refusal", async ({ browser }) => {
  const context = await contextAs(browser, "viewer");
  try {
    const page = await context.newPage();
    await page.goto("/admin/pii");
    await expect(
      page.getByRole("heading", { name: "The admin section is for admins" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a rule" })).toHaveCount(
      0,
    );
    expect((await page.request.get("/api/v1/admin/pii/rules")).status()).toBe(
      403,
    );
    expect(
      (
        await page.request.put("/api/v1/admin/pii/rules", {
          headers: { origin: devStackUrl() },
          data: { kind: "table", table: "Customer", pii: true },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
  }
});

test("a whole-table rule can be removed and restored, and a refusal stays under its field @tenant", async ({
  page,
}) => {
  await page.goto("/admin/pii");
  await page.getByRole("region", { name: /^Rules/ }).waitFor();
  await expect(
    page.getByRole("listitem").filter({ hasText: `'${wholeTable}'` }),
  ).toHaveCount(0);
  createdRules.add(`'${wholeTable}'`);
  await page.getByRole("button", { name: "Add a rule", exact: true }).click();
  const form = page.getByRole("form", { name: "Add a rule" });
  await form
    .getByRole("button", { name: "A whole table", exact: true })
    .click();
  await expect(
    form.getByRole("textbox", { name: "Column", exact: true }),
  ).toHaveCount(0);
  await form
    .getByRole("textbox", { name: "Table", exact: true })
    .fill(` ${wholeTable}`);
  await form.getByRole("button", { name: "Mark PII", exact: true }).click();
  await expect(
    form.getByRole("textbox", { name: "Table", exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("alert")).toHaveText(
    "The table_name has leading or trailing whitespace.",
  );
  await form
    .getByRole("textbox", { name: "Table", exact: true })
    .fill(wholeTable);
  await form
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Reviewed for the sample tenant");
  await form.getByRole("button", { name: "Mark PII", exact: true }).click();
  const rule = page
    .getByRole("listitem")
    .filter({ hasText: "every column of the table" })
    .filter({ hasText: `'${wholeTable}'` });
  try {
    await expect(rule).toContainText("Reviewed for the sample tenant");
    await expect(rule).toContainText("in the browser");
    await page.getByRole("button", { name: "Add a rule", exact: true }).click();
    await form
      .getByRole("button", { name: "A whole table", exact: true })
      .click();
    await form
      .getByRole("textbox", { name: "Table", exact: true })
      .fill(wholeTable);
    await form
      .getByRole("button", { name: "Mark not PII", exact: true })
      .click();
    await expect(rule).toContainText("Not PII");
    await page
      .getByRole("status")
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(rule).not.toContainText("Not PII");
    await expect(rule).toContainText("Reviewed for the sample tenant");
    await rule.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(rule).toHaveCount(0);
    await page
      .getByRole("status")
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(rule).toBeVisible();
    await page.reload();
    await expect(rule).toBeVisible();
  } finally {
    await rule.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(rule).toHaveCount(0);
  }
});
