import type { Page } from "@playwright/test";
import { expect, openColumn, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

/** The first lane is a drawer below 1024px, with no edge to drag and nothing to hide it. */
const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Sidebar" });
const edge = (page: Page) =>
  page.getByRole("separator", { name: "Resize the sidebar" });
const mainNav = (page: Page) =>
  page.getByRole("navigation", { name: "Main", exact: true });

async function sidebarWidth(page: Page): Promise<number> {
  const box = await sidebar(page).boundingBox();
  if (box === null) throw new Error("The sidebar is not showing.");
  return box.width;
}

/** Drags the sidebar's edge with the mouse to x, from the middle of its strip. */
async function dragEdgeTo(page: Page, x: number): Promise<void> {
  const box = await edge(page).boundingBox();
  if (box === null) throw new Error("The sidebar's edge is not showing.");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

test("below 1024 pixels the sidebar stays the drawer, with no edge to drag and nothing to hide it", async ({
  page,
}) => {
  await page.goto("/");
  if (!narrow(page)) {
    await expect(edge(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Hide the sidebar" }),
    ).toBeVisible();
    return;
  }
  await expect(edge(page)).toHaveCount(0);
  await page.keyboard.press("[");
  await openColumn(page);
  await expect(mainNav(page)).toBeVisible();
  await expect(edge(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Hide the sidebar" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show the sidebar" }),
  ).toHaveCount(0);
  // The [ pressed at this width changed nothing: on a wide screen the sidebar shows.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(mainNav(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show the sidebar" }),
  ).toHaveCount(0);
});

test("the sidebar hides and shows with its buttons and with [, and stays hidden across a reload", async ({
  page,
}) => {
  await page.goto("/");
  if (narrow(page)) {
    await expect(mainNav(page)).toBeHidden();
    await openColumn(page);
    await expect(mainNav(page)).toBeVisible();
    return;
  }
  const hide = page.getByRole("button", { name: "Hide the sidebar" });
  const show = page.getByRole("button", { name: "Show the sidebar" });
  await expect(show).toHaveCount(0);
  await hide.click();
  await expect(mainNav(page)).toBeHidden();
  await expect(show).toBeFocused();
  await expect(show).toHaveAttribute("aria-expanded", "false");
  // The page takes the room the sidebar had.
  const content = await page.getByRole("main").boundingBox();
  expect(content?.x).toBeLessThan(268);

  await page.reload();
  await expect(mainNav(page)).toBeHidden();
  await show.click();
  await expect(mainNav(page)).toBeVisible();
  await expect(hide).toBeFocused();

  await page.keyboard.press("[");
  await expect(mainNav(page)).toBeHidden();
  await expect(show).toBeFocused();
  await page.keyboard.press("[");
  await expect(mainNav(page)).toBeVisible();
  await page.reload();
  await expect(mainNav(page)).toBeVisible();

  // In a field [ is text, and Cmd+[ or Ctrl+[ stays the browser's.
  // On Home, / focuses Home's own box and opens no dialog.
  const dialog = page.getByRole("dialog", { name: "Search" });
  const homeBox = page
    .getByRole("main")
    .getByRole("searchbox", { name: "Search the catalog" });
  await expect(homeBox).toBeVisible();
  await homeBox.blur();
  await expect(homeBox).not.toBeFocused();
  await page.keyboard.press("/");
  await expect(homeBox).toBeFocused();
  await expect(dialog).toBeHidden();
  await page.keyboard.type("[");
  await expect(homeBox).toHaveValue("[");
  await expect(mainNav(page)).toBeVisible();
  // On another page, / opens the dialog.
  await page.goto("/catalog");
  await page.getByRole("main").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("/");
  const query = dialog.getByRole("combobox");
  await expect(query).toBeFocused();
  await page.keyboard.type("[");
  await expect(query).toHaveValue("[");
  await page.keyboard.press("Escape");
  await expect(mainNav(page)).toBeVisible();
  await page.getByRole("main").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+[");
  await expect(mainNav(page)).toBeVisible();
  // [ typed with AltGr, as on a Danish or German Windows keyboard, arrives as Ctrl+Alt+[.
  await page.keyboard.press("Control+Alt+[");
  await expect(mainNav(page)).toBeHidden();
  await page.keyboard.press("Control+Alt+[");
  await expect(mainNav(page)).toBeVisible();
});

test("dragging the sidebar's edge makes it wider and narrower within its limits, and a drag past its narrowest hides it", async ({
  page,
}) => {
  await page.goto("/");
  if (narrow(page)) {
    await expect(edge(page)).toHaveCount(0);
    return;
  }
  expect(await sidebarWidth(page)).toBe(268);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "268");
  await expect(edge(page)).toHaveAttribute("aria-valuemin", "240");
  await expect(edge(page)).toHaveAttribute("aria-valuemax", "480");

  await dragEdgeTo(page, 360);
  expect(await sidebarWidth(page)).toBe(360);
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "360");
  await dragEdgeTo(page, 1000);
  expect(await sidebarWidth(page)).toBe(480);
  await dragEdgeTo(page, 300);
  expect(await sidebarWidth(page)).toBe(300);
  await dragEdgeTo(page, 160);
  expect(await sidebarWidth(page)).toBe(240);

  await page.reload();
  expect(await sidebarWidth(page)).toBe(240);

  // Let go under half the narrowest width, and the sidebar hides with the width it had.
  await dragEdgeTo(page, 300);
  await dragEdgeTo(page, 40);
  await expect(mainNav(page)).toBeHidden();
  await page.getByRole("button", { name: "Show the sidebar" }).click();
  expect(await sidebarWidth(page)).toBe(300);
});

test("at 1024 pixels in the settings the sidebar widens only as far as leaves the page its room, and keeps the width chosen on a wider screen", async ({
  page,
}) => {
  if (narrow(page)) {
    await page.goto("/admin/powerbi");
    await expect(edge(page)).toHaveCount(0);
    return;
  }
  // Chosen at its widest on a wide screen.
  await page.goto("/");
  await edge(page).focus();
  await page.keyboard.press("End");
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "480");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/admin/powerbi");
  // 1024 less the page's 480 and the settings lane's 220.
  await expect(edge(page)).toHaveAttribute("aria-valuemax", "324");
  expect(await sidebarWidth(page)).toBe(324);
  // Hiding and showing it here keeps the width chosen, which comes back on the wide screen.
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await page.getByRole("button", { name: "Show the sidebar" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "480");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "324");
  // A click on the edge here saves nothing, so the width chosen comes back on the wide screen too.
  await edge(page).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "480");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "324");
  // The edge is above the settings lane, all 12px of it, so a drag moves it both ways, and no further than the room.
  const strip = await edge(page).boundingBox();
  if (strip === null) throw new Error("The sidebar's edge is not showing.");
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
      { x: strip.x + strip.width - 1, y: strip.y + strip.height / 2 },
    ),
  ).toBe("HR");
  await dragEdgeTo(page, 280);
  expect(await sidebarWidth(page)).toBe(280);
  await dragEdgeTo(page, 900);
  expect(await sidebarWidth(page)).toBe(324);
  const settings = await page
    .getByRole("navigation", { name: "Settings pages" })
    .boundingBox();
  const main = await page.getByRole("main").boundingBox();
  expect(main?.width).toBeGreaterThanOrEqual(480);
  expect(settings?.x).toBe(324);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
});

test("the sidebar's edge resizes by keyboard, and the width survives a reload", async ({
  page,
}) => {
  await page.goto("/");
  if (narrow(page)) {
    await expect(edge(page)).toHaveCount(0);
    return;
  }
  // The edge comes after the sidebar's own controls, so Tab reaches it from the last of them.
  await page.getByRole("button", { name: "Sign out" }).focus();
  await page.keyboard.press("Tab");
  await expect(edge(page)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "284");
  expect(await sidebarWidth(page)).toBe(284);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "252");
  await page.keyboard.press("Home");
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "240");
  await page.keyboard.press("End");
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "480");
  expect(await sidebarWidth(page)).toBe(480);

  await page.reload();
  await expect(edge(page)).toHaveAttribute("aria-valuenow", "480");
  expect(await sidebarWidth(page)).toBe(480);
});

test("with the browser's storage refused, the sidebar still resizes and hides for the page", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const refuse = () => {
      throw new DOMException("The site's data is blocked.", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", { get: refuse });
  });
  await page.goto("/");
  if (narrow(page)) {
    await openColumn(page);
    await expect(mainNav(page)).toBeVisible();
    return;
  }
  await dragEdgeTo(page, 360);
  expect(await sidebarWidth(page)).toBe(360);
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await expect(mainNav(page)).toBeHidden();
  await page.reload();
  await expect(mainNav(page)).toBeVisible();
  expect(await sidebarWidth(page)).toBe(268);
});
