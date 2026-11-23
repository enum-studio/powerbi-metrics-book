import { inDemo } from "../../api/src/http/demo-paths.ts";
import { expect, test } from "./fixtures.ts";
import { sampleRoutes } from "./routes.ts";

test.use({ signedInAs: "viewer" });

/** The page tabs of a screen (catalog/datasets/tabs.tsx): the buttons of a nav whose current tab is marked. */
const TABS = "nav:has(> button[aria-current='page']) > button";

/** The kind of element whose documentation a request reads. */
const DOCS = /^\/api\/v1\/elements\/(\w+)\/[^/]+\/docs$/;

/*
 * The public demo answers 404 to every GET DEMO_PATHS does not list
 * (apps/api/src/http/demo-paths.ts), so a screen that reads a route the list
 * leaves out breaks only on the demo. This opens every screen the demo
 * opens, and each of its tabs, at a desktop's width and a phone's, as the
 * viewer on the dev stack with the api answering as the demo does. It fails
 * on any request the demo would refuse, and on any screen that shows an
 * error.
 */
test("the demo's screens send only requests the demo answers @once", async ({
  page,
}) => {
  test.setTimeout(300_000);
  let on = "";
  const refused = new Set<string>();
  const documented = new Set<string>();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/auth/config") {
      // The SPA as the demo runs it (shell/demo.ts), with the demo's sign-in.
      const response = await route.fetch();
      const config = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...config, demo: true, dev_sign_in: false, providers: [] },
      });
    } else if (!inDemo(pathname, method)) {
      refused.add(`${method} ${pathname}, on ${on}`);
      await (method === "GET" || method === "HEAD"
        ? route.fulfill({ status: 404, body: "404 Not Found" })
        : route.fulfill({
            status: 403,
            json: { error: "refused", message: "The demo is read-only." },
          }));
    } else {
      const kind = DOCS.exec(pathname)?.[1];
      if (kind !== undefined) documented.add(kind);
      await route.continue();
    }
  });
  const open = async (address: string) => {
    on = address;
    await page.goto(address, { waitUntil: "networkidle" });
    // A failed read retries for about 7 seconds before its error shows.
    await expect(
      page.getByRole("status").filter({ hasText: /^Loading/ }),
      `still loading ${address}`,
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("alert"), `an error on ${address}`).toHaveCount(
      0,
    );
  };
  const screens = [
    ...(await sampleRoutes()).filter((path) => inDemo(path, "GET")),
    "/?q=sales",
  ];
  let tabs = 0;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
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
  }
  expect(screens.length).toBeGreaterThan(10);
  expect(tabs).toBeGreaterThan(10);
  expect([...documented].sort()).toEqual(["column", "dataset", "table"]);
  expect([...refused]).toEqual([]);
});
