import { inDemo } from "../../api/src/http/demo-paths.ts";
import { expect, test } from "./fixtures.ts";
import { sampleRoutes } from "./routes.ts";

test.use({ signedInAs: "viewer" });

/** The page tabs of a screen (catalog/datasets/tabs.tsx): the buttons of a nav whose current tab is marked. */
const TABS = "nav:has(> button[aria-current='page']) > button";

/*
 * The public demo answers 404 to every request DEMO_PATHS does not list
 * (apps/api/src/http/demo-paths.ts), so a screen that reads a route the list
 * leaves out breaks only on the demo. This opens every screen the demo opens,
 * and each of its tabs, as a viewer on the dev stack, and fails on any
 * request the demo would refuse.
 */
test("the demo's screens send only requests the demo answers @once", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const screens = [
    ...(await sampleRoutes()).filter((path) => inDemo(path, "GET")),
    "/?q=sales",
  ];
  // The SPA as the demo runs it (shell/demo.ts): it sends none of the
  // requests it leaves out there, such as a metric's questions.
  await page.route("**/api/auth/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...config, demo: true } });
  });
  let on = "";
  const refused = new Set<string>();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/") && !inDemo(pathname, request.method()))
      refused.add(`${request.method()} ${pathname}, on ${on}`);
  });
  const open = async (url: string) => {
    on = url;
    await page.goto(url, { waitUntil: "networkidle" });
  };
  let tabs = 0;
  for (const screen of screens) {
    await open(screen);
    const addresses: string[] = [];
    for (const tab of await page.locator(TABS).all()) {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-current", "page");
      const { pathname, search } = new URL(page.url());
      addresses.push(pathname + search);
    }
    // Opened afresh so each tab's reads have all gone out before the next.
    for (const address of addresses) await open(address);
    tabs += addresses.length;
  }
  expect(screens.length).toBeGreaterThan(10);
  expect(tabs).toBeGreaterThan(5);
  expect([...refused]).toEqual([]);
});
