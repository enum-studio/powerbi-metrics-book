import type { Page } from "@playwright/test";
import {
  contextAs,
  devStackUrl,
  expect,
  openColumn,
  openSettings,
  PEOPLE,
  test,
} from "./fixtures.ts";

test.use({ signedInAs: "admin" });

// The mock tenant's invented values (packages/powerbi-mock/src/sample/tenant.ts).
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const APP_CLIENT_ID = "c1000000-0000-4000-8000-000000000002";
const SCANNER_CLIENT_ID = "c1000000-0000-4000-8000-000000000001";

/** The mock's control routes sit on the port beside the api's (scripts/dev-stack.mjs). */
const mock = () =>
  `http://127.0.0.1:${String(Number(new URL(devStackUrl()).port) + 1)}`;

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("the sample viewer gets the admins-only page, and the sample admin the status page", async ({
  browser,
  page,
}) => {
  const viewer = await (await contextAs(browser, "viewer")).newPage();
  await viewer.goto("/admin");
  await expect(
    viewer.getByRole("heading", { name: "The admin section is for admins" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("navigation", { name: "Settings pages" }),
  ).toHaveCount(0);
  await expect(viewer.getByText(PEOPLE.admin)).toHaveCount(0);
  await viewer.context().close();

  // A fresh stack's deploy sync may still be running, and the page says what is so. Wait for the api
  // to say the latest run has ended, then expect the page to say exactly that.
  test.setTimeout(240_000);
  const latest = async () => {
    const answer: unknown = await (
      await page.request.get("/api/v1/admin/sync?limit=1")
    ).json();
    const runs =
      typeof answer === "object" && answer !== null && "runs" in answer
        ? answer.runs
        : null;
    const list: unknown[] = Array.isArray(runs) ? runs : [];
    const run = list[0];
    return typeof run === "object" &&
      run !== null &&
      "status" in run &&
      "kind" in run
      ? `${String(run.kind)} ${String(run.status)}`
      : "none";
  };
  await expect
    .poll(latest, {
      timeout: 200_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toMatch(/^(incremental|full) (succeeded|failed|skipped)$/);
  const [kind, status] = (await latest()).split(" ");
  const said = {
    succeeded: "succeeded",
    failed: "failed",
    skipped: "was skipped",
  }[status ?? ""];
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Status", level: 1 }),
  ).toBeVisible();
  const last = section(page, "Last sync");
  await expect(
    last.getByText(`The last ${kind ?? ""} sync ${said ?? ""}.`),
  ).toBeVisible();
  await expect(
    last.getByRole("button", { name: "Run a sync now" }),
  ).toBeVisible();
  await expect(page.getByText(/Version \S+, build/)).toBeVisible();
  // A time is the viewer's local time with its zone; what started the sync is said in words.
  await expect(
    last.getByText(/Started .+\d{4}, \d{1,2}:\d\d.* (UTC|GMT\S*|[A-Z]{3,5})\b/),
  ).toBeVisible();
  await expect(last).not.toContainText("by deploy");
  await expect(last).not.toContainText("access without right");
});

test("Status lists every failing check under Needs attention, and every other page in its band @tenant", async ({
  page,
}) => {
  const headers = { origin: devStackUrl() };
  const secret = "powerbi_app_client_secret";
  const expiry = `/api/v1/admin/secrets/${secret}/expiry`;
  const { secrets } = (await (
    await page.request.get("/api/v1/admin/secrets")
  ).json()) as { secrets: { name: string; expires_at: string | null }[] };
  const before = secrets.find(({ name }) => name === secret)?.expires_at;
  if (before === undefined) throw new Error(`The stack has no ${secret}.`);
  const set = (expires_at: string | null) =>
    page.request.put(expiry, { headers, data: { expires_at } });
  expect((await set(null)).ok()).toBe(true);
  try {
    const status = (await (
      await page.request.get("/api/v1/admin/status")
    ).json()) as { failing_checks: { name: string }[] };
    expect(status.failing_checks.map(({ name }) => name)).toContain(
      `expiry_${secret}`,
    );
    await page.goto("/admin");
    const banner = page.getByRole("status", { name: "Failing checks" });
    const needs = section(page, "Needs attention");
    for (const { name } of status.failing_checks)
      await expect(needs.getByText(name, { exact: true })).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.goto("/admin/limits");
    await banner.getByText(/failing$/).click();
    for (const { name } of status.failing_checks)
      await expect(banner.getByText(name, { exact: true })).toBeVisible();
  } finally {
    await set(before);
  }
});

test("Status is a row of the first lane, and Settings' pages are a second left lane, or nested in the drawer", async ({
  page,
}) => {
  await page.goto("/admin");
  await openColumn(page);
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link", { name: "Status" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const pages = page.getByRole("navigation", { name: "Settings pages" });
  await expect(pages).toHaveCount(0);
  await openSettings(page);
  await pages.getByRole("link", { name: "Users and roles" }).click();
  await expect(page).toHaveURL(/\/admin\/people$/);
  await expect(
    page.getByRole("heading", { name: "Users and roles", level: 1 }),
  ).toBeVisible();
  await openColumn(page);
  // One page is the page: its own row says so, and nothing else among the pages does.
  await expect(pages.locator('[aria-current="page"]')).toHaveText(
    "Users and roles",
  );
  await expect(pages.locator('[data-status="active"]')).toHaveCount(1);
});

test("a hovered row does not look like the current page", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/admin/powerbi");
  const pages = page.getByRole("navigation", { name: "Settings pages" });
  const look = (name: string) =>
    pages.getByRole("link", { name, exact: true }).evaluate((row) => {
      const { backgroundColor, color } = getComputedStyle(row);
      return { backgroundColor, color };
    });
  const current = await look("Power BI");
  await pages.getByRole("link", { name: "PII", exact: true }).hover();
  await expect.poll(() => look("PII")).not.toEqual(await look("Datasets"));
  const hovered = await look("PII");
  expect(hovered.backgroundColor).not.toBe(current.backgroundColor);
  expect(hovered.color).not.toBe(current.color);
  await expect(pages.locator('[data-status="active"]')).toHaveText("Power BI");
  // On a page it does not link to, the first lane's row holds the place without calling itself the page.
  await pages.getByRole("link", { name: "PII", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});

for (const width of [1024, 1280])
  test(`at ${String(width)}px both lanes stay on the left, and a wide table scrolls inside the page`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, name] of [
      ["/admin/pii", "PII"],
      ["/admin/datasets", "Datasets"],
      ["/admin/people", "Users and roles"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
      await expect(
        page.getByRole("main").getByRole("table").first(),
      ).toBeVisible();
      const lane = await page
        .getByRole("navigation", { name: "Settings pages" })
        .boundingBox();
      expect(lane?.height).toBe(800);
      expect(lane?.x).toBeGreaterThan(0);
      const { sideways, over } = await page.evaluate(() => {
        const main = document.querySelector("main");
        return {
          sideways: document.documentElement.scrollWidth - window.innerWidth,
          over: main === null ? null : main.scrollWidth - main.clientWidth,
        };
      });
      expect(sideways).toBe(0);
      expect(over).toBe(0);
    }
    // A table wider than the page scrolls in its box, the page does not: PII
    // at both widths, Users and roles at 1024px. At 1280px Users and roles
    // fits, with its last column in view.
    for (const [path, wider] of [
      ["/admin/pii", true],
      ["/admin/people", width === 1024],
    ] as const) {
      await page.goto(path);
      await expect(
        page.getByRole("main").getByRole("table").first(),
      ).toBeVisible();
      const scrolled = await page
        .getByRole("main")
        .locator(".overflow-x-auto")
        .first()
        .evaluate((element) => {
          element.scrollLeft = 80;
          return element.scrollLeft > 0;
        });
      expect(scrolled, `${path} scrolls inside its box`).toBe(wider);
    }
    if (width === 1280)
      await expect(
        page
          .getByRole("main")
          .getByRole("columnheader", { name: "Actions", exact: true }),
      ).toBeInViewport({ ratio: 1 });
  });

test("the drawer holds Settings' pages, opens them on the current one, and keeps the tree reachable beside them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/people");
  await expect(
    page.getByRole("navigation", { name: "Settings pages" }),
  ).toHaveCount(0);
  await openColumn(page);
  const pages = page.getByRole("navigation", { name: "Settings pages" });
  await expect(pages.locator('[aria-current="page"]')).toHaveText(
    "Users and roles",
  );
  const main = page.getByRole("navigation", { name: "Main" });
  const settings = main.getByRole("button", { name: "Settings", exact: true });
  // Folded, Settings stands for the page it holds.
  await settings.click();
  await expect(pages).toHaveCount(0);
  await expect(settings.locator('[aria-current="true"]')).toHaveCount(1);
  await settings.click();
  await expect(settings.locator('[aria-current="true"]')).toHaveCount(0);
  // Beside the open pages, the tree has its full height and the lane scrolls instead.
  const tree = page.getByRole("navigation", { name: "Catalog", exact: true });
  await tree.getByRole("button", { name: "Open Metrics" }).waitFor();
  const room = await tree.locator("..").boundingBox();
  const rows = await tree.boundingBox();
  expect(room?.height).toBeGreaterThanOrEqual(rows?.height ?? Infinity);
  // A taken page closes the drawer.
  await pages.getByRole("link", { name: "PII", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/pii$/);
  await expect(
    page.getByRole("button", { name: "Open the menu" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
  // On a landscape phone the current row is brought into view as the drawer opens.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/admin/audit");
  await openColumn(page);
  await expect(
    pages.getByRole("link", { name: "Audit log", exact: true }),
  ).toBeInViewport({ ratio: 1 });
});

test.describe("each page renders with the sample tenant's values", () => {
  test("Power BI", async ({ page }) => {
    await page.goto("/admin/powerbi");
    await expect(page.getByLabel("Tenant id")).toHaveValue(TENANT_ID);
    await expect(
      section(page, "App registration").getByLabel("Client id"),
    ).toHaveValue(APP_CLIENT_ID);
    await expect(
      section(page, "Scanner registration").getByLabel("Client id"),
    ).toHaveValue(SCANNER_CLIENT_ID);
    await expect(
      section(page, "Scanner registration").getByText(
        "powerbi_scanner_client_secret",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Next run in/).first()).toBeVisible();
    const cloud = section(page, "National clouds");
    await expect(cloud.getByText("POWERBI_AUTHORITY")).toBeVisible();
    await expect(cloud.getByRole("textbox")).toHaveCount(0);
    for (const name of [
      "App registration",
      "Scanner registration",
      "What to sync",
    ])
      await expect(
        section(page, name).getByRole("button", { name: "Check" }),
      ).toBeVisible();
  });

  test("Authentication", async ({ page }) => {
    await page.goto("/admin/sign-in");
    await expect(
      page.getByRole("heading", { name: "Microsoft" }),
    ).toBeVisible();
    // Microsoft's two redirect URIs, each named by what it is for.
    await expect(
      page.getByLabel("Sign-in redirect URI", { exact: true }),
    ).toHaveValue(/\/api\/auth\/callback\/microsoft$/);
    await expect(
      page.getByLabel("Power BI connection redirect URI", { exact: true }),
    ).toHaveValue(/\/api\/v1\/powerbi\/callback$/);
    await expect(
      page.getByRole("button", { name: "Add Google" }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Passkeys" }),
    ).toBeVisible();
  });

  test("Search", async ({ page }) => {
    await page.goto("/admin/search");
    await expect(page.getByLabel("Provider", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
    await expect(page.getByText("SEARCH_BASE_URL")).toBeVisible();
  });

  test("Limits", async ({ page }) => {
    await page.goto("/admin/limits");
    for (const label of [
      "Result lifetime (hours)",
      "Preview rows",
      "Page size (rows)",
      "Daily row budget",
      "Queries per minute",
    ])
      await expect(page.getByLabel(label)).toHaveValue(/^\d+$/);
  });

  test("Secrets", async ({ page }) => {
    await page.goto("/admin/secrets");
    for (const name of [
      "powerbi_app_client_secret",
      "powerbi_scanner_client_secret",
    ]) {
      const row = page.getByRole("group", { name });
      await expect(row.getByText(/set, ends in/)).toBeVisible();
      await expect(row.getByRole("button", { name: "Check" })).toBeVisible();
    }
  });
});

// Only the tenant project writes this shared setting.
const PREVIEW_ROWS: Record<string, [number, number]> = {
  tenant: [105, 115],
};

test("changing preview rows saves @tenant", async ({ page }, testInfo) => {
  const mine = PREVIEW_ROWS[testInfo.project.name];
  if (mine === undefined)
    throw new Error(`No preview rows value for ${testInfo.project.name}`);
  await page.goto("/admin/limits");
  const field = page.getByLabel("Preview rows");
  const save = async (value: number) => {
    await field.fill(String(value));
    const [answer] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/admin/settings/results.preview_rows") &&
          r.request().method() === "PUT",
      ),
      page.getByRole("button", { name: "Save" }).first().click(),
    ]);
    expect(answer.status()).toBe(200);
    // Check both the submitted value and the saved setting.
    expect(answer.request().postDataJSON()).toMatchObject({ value });
    expect(await answer.json()).toMatchObject({
      key: "results.preview_rows",
      source: "database",
    });
    await expect(page.getByText("Saved.")).toBeVisible();
  };
  // Whatever the stack holds (a default, another project's value, or this
  // project's from an earlier run), one of this project's two values differs.
  const [first, second] = mine;
  const shown = await field.inputValue();
  const [one, two] =
    shown === String(first) ? [second, first] : [first, second];
  try {
    await save(one);
    await save(two);
  } finally {
    expect(
      (
        await page.request.put("/api/v1/admin/settings/results.preview_rows", {
          headers: { origin: devStackUrl() },
          data: { value: Number(shown) },
        })
      ).ok(),
    ).toBe(true);
  }
});

test("an expiry date saves alone, leaving the value as it was, and the Authentication page takes the email settings @once", async ({
  page,
}) => {
  await page.goto("/admin/secrets");
  const row = page.getByRole("group", { name: "powerbi_app_client_secret" });
  const value = row.getByText(/^set, ends in/);
  const before = await value.textContent();
  const saveDate = async (date: string) => {
    await row.getByRole("button", { name: "Expiry date" }).click();
    const field = row.locator('input[type="date"]');
    const was = await field.inputValue();
    await field.fill(date);
    await row.getByRole("button", { name: "Save date" }).click();
    await expect(row.getByRole("button", { name: "Save date" })).toHaveCount(0);
    return was;
  };
  const original = await saveDate("2030-01-15");
  await expect(row.getByText("expires on 2030-01-15")).toBeVisible();
  await expect(value).toHaveText(before ?? "");
  await page.reload();
  await expect(row.getByText("expires on 2030-01-15")).toBeVisible();
  await saveDate(original);
  await expect(row.getByText("expires on 2030-01-15")).toHaveCount(0);

  await page.goto("/admin/sign-in");
  await expect(
    section(page, "Email").getByLabel("Sender address"),
  ).toBeVisible();
  await expect(
    section(page, "Email").getByRole("group", { name: "resend_api_key" }),
  ).toBeVisible();
  await expect(
    section(page, "Password sign-in").getByLabel("Password sign-in"),
  ).toBeVisible();
});

test("setting a secret shows only its last four characters, sends no setting with it, and leaves the value nowhere @tenant", async ({
  page,
}) => {
  // A provider of this test's own, so its secret exists only while the test runs
  // and removing the provider deletes it. The secrets every deployment has stay as they are.
  const probe = {
    id: "e2e_probe",
    kind: "google",
    label: "E2E probe",
    client_id: "probe-client",
    issuer: null,
  };
  const providers = "/api/v1/admin/settings/sign_in.providers";
  const headers = { origin: devStackUrl() };
  const current: unknown = await (await page.request.get(providers)).json();
  const held =
    typeof current === "object" && current !== null && "value" in current
      ? current.value
      : null;
  // Without the probe, in case an earlier run that was stopped left it behind.
  const before: unknown[] = Array.isArray(held)
    ? held.filter(
        (provider: unknown) =>
          typeof provider !== "object" ||
          provider === null ||
          !("id" in provider) ||
          provider.id !== probe.id,
      )
    : [];
  const save = (value: unknown) =>
    page.request.put(providers, {
      headers,
      data: { value, save_failing: true },
    });
  const value = "probe-secret-value-q7Zk";
  const puts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/settings/"))
      puts.push(request.url());
  });
  // Setting a secret runs the section's check, which tries the probe provider's address; this test is about the secret, not that call.
  await page.route("**/api/v1/admin/checks/sign_in", (route) =>
    route.fulfill({ json: { status: "passing", message: null } }),
  );
  try {
    expect((await save([probe])).ok()).toBe(true);
    await page.goto("/admin/sign-in");
    // An edit waits in the providers form, unsaved.
    const label = page.getByLabel("Name on the sign-in page");
    await label.fill("Edited, not saved");

    const row = page.getByRole("group", {
      name: "sign_in_e2e_probe_client_secret",
    });
    await row.getByRole("button", { name: /^(Set|Replace)$/ }).click();
    const field = row.getByLabel("New value");
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveAttribute("autocomplete", "new-password");
    await expect(field).toHaveAttribute("data-1p-ignore");
    await expect(field).toHaveAttribute("data-lpignore", "true");
    await expect(field).toHaveAttribute("data-bwignore");
    await field.fill(value);
    await row.getByRole("button", { name: "Save secret" }).click();
    await expect(row.getByText(/set, ends in/)).toContainText("q7Zk");
    await expect(row.getByLabel("New value")).toHaveCount(0);
    // The secret's form is its own: the providers form sent nothing, and kept its edit.
    expect(puts).toEqual([]);
    await expect(label).toHaveValue("Edited, not saved");

    const everywhere = async () =>
      (await page.content()) +
      (await page.evaluate(
        () =>
          document.body.innerText +
          JSON.stringify(Object.entries(localStorage)) +
          JSON.stringify(Object.entries(sessionStorage)),
      )) +
      page.url();
    expect(await everywhere()).not.toContain(value);
    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "sign_in_e2e_probe_client_secret" })
        .getByText(/ends in/),
    ).toContainText("q7Zk");
    expect(await everywhere()).not.toContain(value);
  } finally {
    // Back to the providers there were, which deletes the probe's secret.
    await save(before);
  }
});

test("a value whose check fails shows the check's sentence, and Save anyway sends it marked failing", async ({
  page,
}) => {
  await page.goto("/admin/powerbi");
  const sentence =
    "Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.";
  const sent: unknown[] = [];
  await page.route(
    "**/api/v1/admin/settings/powerbi.scanner_client_id",
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const body: unknown = route.request().postDataJSON();
      sent.push(body);
      const anyway =
        typeof body === "object" &&
        body !== null &&
        "save_failing" in body &&
        body.save_failing === true;
      if (!anyway)
        return route.fulfill({
          status: 400,
          json: {
            error: "invalid",
            message: `powerbi.scanner_client_id failed its check: ${sentence}. Save it with save_failing to keep it anyway.`,
            save_failing_allowed: true,
            check: { name: "powerbi.scanner_client_id", message: sentence },
          },
        });
      const current = await page.request.get(
        "/api/v1/admin/settings/powerbi.scanner_client_id",
      );
      return route.fulfill({ response: current });
    },
  );
  await page.route("**/api/v1/admin/checks/scanner", (route) =>
    route.fulfill({ json: { status: "failing", message: sentence } }),
  );
  const scanner = section(page, "Scanner registration");
  await scanner
    .getByLabel("Client id")
    .fill(SCANNER_CLIENT_ID.replace(/1$/, "9"));
  await scanner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(scanner.getByRole("alert").first()).toContainText(sentence);
  await scanner.getByRole("button", { name: "Save anyway" }).click();
  await expect(scanner.getByText("Failing.")).toBeVisible();
  expect(sent).toMatchObject([{ save_failing: false }, { save_failing: true }]);
});

test("turning off the scanner's admin API access fails its Check with the sentence, and every admin page carries the band @tenant", async ({
  page,
}) => {
  const control = (allowed: boolean) =>
    page.request.patch(`${mock()}/_mock/settings`, {
      data: {
        service_principal: {
          app_id: SCANNER_CLIENT_ID,
          may_call_admin_apis: allowed,
        },
      },
    });
  try {
    expect((await control(false)).ok()).toBe(true);
    await page.goto("/admin/powerbi");
    const scanner = section(page, "Scanner registration");
    await scanner.getByRole("button", { name: "Check" }).click();
    // The worker runs it: the request answers at once, and the page polls.
    await expect(scanner.getByText("Checking.")).toBeVisible();
    await expect(scanner.getByRole("alert")).toContainText(
      "Power BI refused admin APIs to this service principal",
      { timeout: 90_000 },
    );
    await page.goto("/admin");
    await expect(
      section(page, "Needs attention").getByRole("link", {
        name: "Open Power BI",
      }),
    ).toHaveAttribute("href", "/admin/powerbi");
    for (const path of ["/admin/limits", "/admin/secrets"]) {
      await page.goto(path);
      const band = page.getByRole("status", { name: "Failing checks" });
      await band.getByText(/failing$/).click();
      await expect(band).toContainText("scanner");
      await expect(
        band.getByRole("link", { name: "Open Power BI" }),
      ).toHaveAttribute("href", "/admin/powerbi");
    }
  } finally {
    await control(true);
    await page.goto("/admin/powerbi");
    const scanner = section(page, "Scanner registration");
    await scanner.getByRole("button", { name: "Check" }).click();
    await expect(scanner.getByText("Passing.")).toBeVisible({
      timeout: 90_000,
    });
  }
});
