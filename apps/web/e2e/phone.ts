import type { CDPSession, Locator, Page } from "@playwright/test";

/** The narrowest phone a page must fit and a common one. */
export const PHONES = [320, 390] as const;
export const TOUCH = { isMobile: true, hasTouch: true };

/**
 * What is wrong with the page at a phone's width: anything that widens the
 * document or reaches past the screen outside a box that scrolls by itself,
 * and any field whose text is small enough that iOS zooms in on it and stays
 * zoomed, which pushes the page off the screen just the same.
 */
export function problemsAt(width: number): string[] {
  const problems: string[] = [];
  const name = (element: Element) =>
    `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}"`;
  const scrollsAround = (element: Element) => {
    for (
      let around = element.parentElement;
      around !== null && around !== document.body;
      around = around.parentElement
    )
      if (getComputedStyle(around).overflowX !== "visible") return true;
    return false;
  };
  if (document.documentElement.scrollWidth > width)
    problems.push(
      `the document is ${String(document.documentElement.scrollWidth)}px wide`,
    );
  for (const element of document.body.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      box.right > width + 0.5 &&
      !scrollsAround(element)
    )
      problems.push(`${name(element)} reaches ${String(box.right)}px`);
  }
  for (const field of document.querySelectorAll(
    'input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea',
  )) {
    const size = parseFloat(getComputedStyle(field).fontSize);
    if (size < 16)
      problems.push(`a field's text is ${String(size)}px, and iOS zooms in`);
  }
  return problems;
}

/** The smallest a control may be on a touch screen, both ways: the tokens' --tap. */
export const TAP = 44;

/**
 * Each of the targets smaller than TAP either way, with its size, for a page
 * on a touch screen. No target at all is an error, so the check can fail.
 */
export async function smallTargets(targets: Locator): Promise<string[]> {
  const all = await targets.all();
  if (all.length === 0)
    throw new Error(`${targets.toString()} matched no target to measure`);
  const small: string[] = [];
  for (const target of all) {
    const box = await target.boundingBox();
    if (box === null) throw new Error(`${target.toString()} is not shown`);
    if (box.width < TAP || box.height < TAP)
      small.push(
        `"${(await target.innerText()).trim()}" is ${String(Math.round(box.width))} by ${String(Math.round(box.height))}px`,
      );
  }
  return small;
}

/** What a page's emulation is, as the page itself and Playwright see it. */
export async function emulationOf(page: Page) {
  return {
    viewport: page.viewportSize(),
    ...(await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      devicePixelRatio,
      screen: { width: screen.width, height: screen.height },
      orientation: {
        type: screen.orientation.type,
        angle: screen.orientation.angle,
      },
      maxTouchPoints: navigator.maxTouchPoints,
      coarse: matchMedia("(pointer: coarse)").matches,
    }))),
  };
}

/**
 * One DevTools session per page, kept for the page's life: detaching drops
 * what the session set and leaves the page at Chromium's own window and
 * screen, not at Playwright's, so the session that gives the page back its
 * metrics stays attached and is used again.
 */
const sessions = new WeakMap<Page, Promise<CDPSession>>();
function sessionOf(page: Page): Promise<CDPSession> {
  let session = sessions.get(page);
  if (session === undefined) {
    session = page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  return session;
}

/**
 * problemsAt on a desktop page in the middle of a flow, whose state a new
 * context would lose: the page is held at each phone's width on a touch
 * screen, as Chromium's device mode does, and `also` runs there too. Then
 * the page gets back the exact metrics Playwright gave it (its crPage
 * _updateViewport), so Playwright's record of them stays true. A page that is already touch or mobile is
 * refused: check it with problemsAt in its own context.
 */
export async function problemsOnPhones(
  page: Page,
  also: (width: number) => Promise<string[]> = () => Promise.resolve([]),
): Promise<string[]> {
  const own = await emulationOf(page);
  if (own.viewport === null)
    throw new Error("The page has no viewport to give back.");
  // Playwright gives a desktop context this orientation and no touch (its crPage _updateViewport).
  if (
    own.maxTouchPoints > 0 ||
    own.orientation.type !== "landscape-primary" ||
    own.orientation.angle !== 0
  )
    throw new Error(
      "problemsOnPhones takes a desktop page; this one is touch or mobile, so check it with problemsAt.",
    );
  const cdp = await sessionOf(page);
  const found: string[] = [];
  try {
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    for (const width of PHONES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 700,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await page.waitForFunction(
        (wide) =>
          innerWidth === wide && matchMedia("(pointer: coarse)").matches,
        width,
      );
      for (const problem of [
        ...(await page.evaluate(problemsAt, width)),
        ...(await also(width)),
      ])
        found.push(`at ${String(width)}px: ${problem}`);
    }
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: own.viewport.width,
      height: own.viewport.height,
      screenWidth: own.screen.width,
      screenHeight: own.screen.height,
      deviceScaleFactor: own.devicePixelRatio,
      screenOrientation: { angle: 0, type: "landscapePrimary" },
    });
  }
  return found;
}
