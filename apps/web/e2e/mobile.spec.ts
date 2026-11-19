import type { Page } from "@playwright/test";
import { contextAs, expect, test } from "./fixtures.ts";
import { openConsent, registerClient } from "./oauth.ts";
import {
  emulationOf,
  PHONES,
  problemsAt,
  problemsOnPhones,
  smallTargets,
  TAP,
  TOUCH,
} from "./phone.ts";
import { sampleRoutes } from "./routes.ts";

/**
 * Words on the wire a company writes, a check says or Power BI names: made
 * unbroken and long, as a real address, key or table name can be. A name is
 * lengthened everywhere it is sent, so a table and the lines that name it
 * still meet.
 */
const WRITTEN = new Set([
  "actor",
  "author_name",
  "body",
  "check_message",
  "claimed_name",
  "client_name",
  "column_name",
  "dataset_name",
  "definition",
  "description",
  "detail",
  "display_name",
  "email",
  "from_column",
  "from_table",
  "label",
  "message",
  "name",
  "note",
  "principal_name",
  "reason",
  "set_by",
  "short_description",
  "summary",
  "table",
  "table_name",
  "title",
  "to_column",
  "to_table",
  "verified_by_name",
  "when_to_use",
  "workspace_name",
]);
const UNBROKEN = `_${"averyveryverylongunbrokenword".repeat(4)}`;

async function answerWithLongWords(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    // Every GET of every page passes through here. A browser sends a request
    // again when the api closes an idle kept-alive socket as it is reused, and
    // route.fetch does too only when told: it retries just ECONNRESET. A name
    // the page read from an earlier answer goes back to the api as it was.
    const answer = await route.fetch({
      url: route.request().url().replaceAll(UNBROKEN, ""),
      maxRetries: 1,
    });
    if (!answer.headers()["content-type"]?.includes("json")) {
      await route.fulfill({ response: answer });
      return;
    }
    await route.fulfill({
      response: answer,
      json: JSON.parse(await answer.text(), (key, value: unknown) =>
        typeof value === "string" && WRITTEN.has(key)
          ? `${value}${UNBROKEN}`
          : value,
      ) as unknown,
    });
  });
}

async function problemsOn(
  page: Page,
  routes: readonly string[],
  width: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    for (const problem of await page.evaluate(problemsAt, width))
      found.push(`${route}: ${problem}`);
  }
  return found;
}

/** The sample's dataset with the most tables, relationships and measures. */
const RETAIL = "/catalog/datasets/d1000000-0000-4000-8000-000000000005";

/**
 * The dataset page past its first look: each tab tapped, then a
 * relationship's panel and a table's panel opened, then a table's page and
 * each of its tabs, each checked as it stands.
 */
async function datasetProblems(page: Page, width: number): Promise<string[]> {
  const found: string[] = [];
  const check = async (where: string) => {
    await page.waitForLoadState("networkidle");
    for (const problem of await page.evaluate(problemsAt, width))
      found.push(`${where}: ${problem}`);
  };
  // A tab with a count is matched by its word and a space; one without, by the word alone.
  const tabOf = (nav: string, label: string, counted: boolean) =>
    page
      .getByRole("navigation", { name: nav })
      .getByRole(
        "button",
        counted
          ? { name: new RegExp(`^${label} `) }
          : { name: label, exact: true },
      );
  const tabs = async (nav: string, labels: [string, boolean][]) => {
    for (const [label, counted] of labels) {
      const shown = tabOf(nav, label, counted);
      await shown.tap();
      await expect(shown).toHaveClass(/border-accent/);
      await check(`the ${nav} page's ${label} tab`);
    }
  };
  await page.goto(RETAIL);
  await expect(tabOf("Dataset", "Tables", true)).toBeVisible();
  await tabs("Dataset", [
    ["Diagram", false],
    ["Documentation", false],
    ["Tables", true],
    ["Measures", true],
    ["Relationships", true],
  ]);
  await page
    .getByRole("button", { name: /^'Order lines/ })
    .first()
    .tap();
  const panel = page.getByRole("complementary");
  await expect(
    panel.getByRole("heading", { level: 2, name: "Relationship" }),
  ).toBeVisible();
  await check("the relationship panel");
  // A table's name may carry the long word, so it is matched by its start.
  await panel.getByRole("button", { name: /^Order lines/ }).tap();
  await expect(
    panel.getByRole("heading", { level: 2, name: /^Order lines/ }),
  ).toBeVisible();
  await check("the table panel");
  await tabOf("Dataset", "Tables", true).tap();
  // The table's row comes before its fields, one of which is a measure of the same name.
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Order lines/ })
    .first()
    .tap();
  await expect(tabOf("Table", "Documentation", false)).toBeVisible();
  await tabs("Table", [
    ["Documentation", false],
    ["Columns", true],
    ["Measures", true],
    ["Relationships", true],
  ]);
  // The Measures tab asks for each metric's trust state; a long-words route
  // still answering one when the test ends writes to a closed response, which
  // says nothing about the page, so those answers are dropped.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  return found;
}

for (const width of PHONES)
  test.describe(`at ${String(width)} pixels on a touch screen`, () => {
    test.use({ ...TOUCH, viewport: { width, height: 700 } });

    test.describe("signed in", () => {
      test.use({ signedInAs: "admin" });

      test("no page runs past the screen, with the sample's words @once", async ({
        page,
      }) => {
        test.setTimeout(180_000);
        expect(await problemsOn(page, await sampleRoutes(), width)).toEqual([]);
      });

      test("no page runs past the screen, with long unbroken words @once", async ({
        page,
      }) => {
        test.setTimeout(180_000);
        await answerWithLongWords(page);
        expect(await problemsOn(page, await sampleRoutes(), width)).toEqual([]);
      });

      test("the dataset page's tabs and panels stay on the screen, with the sample's words @once", async ({
        page,
      }) => {
        expect(await datasetProblems(page, width)).toEqual([]);
      });

      test("the dataset page's tabs and panels stay on the screen, with long unbroken words @once", async ({
        page,
      }) => {
        await answerWithLongWords(page);
        expect(await datasetProblems(page, width)).toEqual([]);
      });

      test("the controls on /admin/datasets are a finger's size @once", async ({
        page,
      }) => {
        await page.goto("/admin/datasets");
        const main = page.getByRole("main");
        const datasets = main.getByRole("table").getByRole("link");
        await expect(datasets).toHaveCount(5);
        // The segmented controls: New datasets' On and Off, and the list's All, On and Off.
        const options = main.getByRole("group").getByRole("button");
        await expect(options).toHaveCount(5);
        expect([
          ...(await smallTargets(datasets)),
          ...(await smallTargets(options)),
        ]).toEqual([]);
        // Measuring nothing is an error, never a pass.
        await expect(
          smallTargets(main.getByRole("link", { name: "No such dataset" })),
        ).rejects.toThrow("matched no target to measure");
      });

      test("the drawer's header stays clear of its rows, and opening it draws no ring @once", async ({
        page,
      }) => {
        await page.goto("/admin/secrets");
        await page.getByRole("button", { name: "Open the menu" }).tap();
        const drawer = page.getByRole("dialog", { name: "Menu" });
        const main = drawer.getByRole("navigation", {
          name: "Main",
          exact: true,
        });
        await expect(main).toBeVisible();

        // Focus is on the drawer itself: the first Tab reaches a link and shows its ring.
        await expect(drawer).toBeFocused();
        await page.keyboard.press("Tab");
        const logo = drawer.getByRole("link", {
          name: "Power BI Metrics Book",
        });
        await expect(logo).toBeFocused();
        expect(
          await logo.evaluate((link) => ({
            ring: link.matches(":focus-visible"),
            style: getComputedStyle(link).outlineStyle,
          })),
        ).toEqual({ ring: true, style: "solid" });

        const clearance = await main.evaluate((list, floor) => {
          list.scrollTop = 30;
          const header = list.previousElementSibling;
          if (header === null) throw new Error("The drawer has no header");
          const top = header.getBoundingClientRect();
          const room = list.getBoundingClientRect();
          const row = list.querySelector("a");
          if (row === null) throw new Error("The drawer has no rows");
          const left = row.getBoundingClientRect().left + 20;
          const under = document.elementFromPoint(left, top.bottom - 1);
          const parts = /[\d.]+/g[Symbol.matchAll](
            getComputedStyle(header).backgroundColor,
          );
          const colour = Array.from(parts, (part) => Number(part[0]));
          return {
            opaque: colour.length === 3 || colour[3] === 1,
            tallEnough: top.height >= floor,
            rowsStartBelowIt: room.top >= top.bottom,
            coversRows: under !== null && header.contains(under),
            scrolled: list.scrollTop > 0,
          };
        }, TAP);
        expect(clearance).toEqual({
          opaque: true,
          tallEnough: true,
          rowsStartBelowIt: true,
          coversRows: true,
          scrolled: true,
        });

        // The last row scrolls clear of the account row, which sits inside the screen.
        const foot = await main.evaluate((list) => {
          list.scrollTop = list.scrollHeight;
          const rows = list.querySelectorAll("a");
          const last = rows[rows.length - 1];
          const account = list.nextElementSibling;
          if (last === undefined || account === null)
            throw new Error("The drawer has no last row or account row");
          return {
            lastRowClear:
              last.getBoundingClientRect().bottom <=
              account.getBoundingClientRect().top,
            accountOnScreen:
              account.getBoundingClientRect().bottom <= window.innerHeight,
          };
        });
        expect(foot).toEqual({ lastRowClear: true, accountOnScreen: true });

        await page.keyboard.press("Escape");
        await expect(main).toBeHidden();
      });
    });

    test.describe("signed out", () => {
      test("no page runs past the screen @once", async ({ page }) => {
        test.setTimeout(180_000);
        expect(await problemsOn(page, await sampleRoutes(), width)).toEqual([]);
      });
    });
  });

// A registered client names itself, so its name can be one word as long as
// registering takes, 100 characters. One client serves both widths: a run
// registers close to the limit of 10 a minute per address.
test("the consent for a client and its scopes stays on the screen at each phone's width @once", async ({
  browser,
}) => {
  const { client_id, name } = await registerClient(
    "e2eclient".padEnd(100, "averyverylongunbrokenname"),
  );
  expect(name).toHaveLength(100);
  for (const width of PHONES) {
    const context = await contextAs(browser, "admin", {
      ...TOUCH,
      viewport: { width, height: 700 },
    });
    try {
      const page = await context.newPage();
      await openConsent(page, client_id);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `${name} (name not checked)`,
      );
      await expect(page.getByText("It will not be able to")).toBeVisible();
      await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
      expect(
        await page.evaluate(problemsAt, width),
        `at ${String(width)}px`,
      ).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

// The setup and password specs check a desktop page mid-flow at phone widths, then go on with it.
test("checking a desktop page at phone widths gives it back as it was, and a touch or mobile page is refused @once", async ({
  browser,
}) => {
  for (const options of [
    { viewport: { width: 1440, height: 900 } },
    {
      viewport: { width: 1024, height: 700 },
      deviceScaleFactor: 2,
      screen: { width: 1600, height: 1000 },
    },
  ]) {
    const context = await contextAs(browser, "admin", options);
    try {
      const page = await context.newPage();
      await page.goto("/admin/datasets");
      // Every check of a page goes through one DevTools session.
      const newSession = context.newCDPSession.bind(context);
      let sessions = 0;
      context.newCDPSession = (target) => {
        sessions += 1;
        return newSession(target);
      };
      const before = await emulationOf(page);
      for (let check = 0; check < 2; check++) {
        expect(await problemsOnPhones(page)).toEqual([]);
        expect(await emulationOf(page)).toEqual(before);
      }
      expect(sessions).toBe(1);
      // Playwright still sets the page's size: a new one takes, and the old one again.
      for (const size of [{ width: 800, height: 600 }, options.viewport]) {
        await page.setViewportSize(size);
        expect(
          await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })),
        ).toEqual(size);
      }
    } finally {
      await context.close();
    }
  }
  for (const options of [TOUCH, { hasTouch: true }, { isMobile: true }]) {
    const context = await contextAs(browser, "admin", {
      ...options,
      viewport: { width: 390, height: 700 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/admin/datasets");
      await expect(problemsOnPhones(page)).rejects.toThrow(
        "problemsOnPhones takes a desktop page",
      );
    } finally {
      await context.close();
    }
  }
});
