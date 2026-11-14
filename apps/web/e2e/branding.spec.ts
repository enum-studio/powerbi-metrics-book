import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import {
  changed,
  contextAs,
  devStackUrl,
  expect,
  forget,
  getJson,
  test,
} from "./fixtures.ts";

const BASE = devStackUrl();
const NAME = "/api/v1/admin/settings/branding.name";
const LOGO = "/api/v1/admin/branding/logo";
/** A PNG of one pixel: the smallest logo the upload takes. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Opens a signed-out page: its heading, the brand's logo drawn, no app header, and nothing past the screen's edge. */
async function branded(
  guest: BrowserContext,
  path: string,
  heading: string,
  brand: string,
) {
  const page = await guest.newPage();
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  const logo = page.getByRole("img", { name: brand, exact: true });
  await expect(logo).toBeVisible();
  await expect
    .poll(() =>
      logo.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(
    page.getByText("Powered by Power BI Metrics Book"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

// The brand is on every page and email, so this runs alone and puts the old one back.
test("a brand name and logo set under General show on the signed-out sign-in and invite pages @tenant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const id = randomUUID().slice(0, 8);
  const brand = `Sample Brand ${id}`;
  const email = `brand-${id}@sample.example`;
  const admin = await contextAs(browser, "admin");
  const { value: name } = await getJson<{ value: unknown }>(
    admin.request,
    NAME,
  );
  const { brand: was } = await getJson<{ brand: { logo_url: string | null } }>(
    admin.request,
    "/api/auth/config",
  );
  const before = was.logo_url && (await admin.request.get(was.logo_url));
  const logo = before && {
    data: await before.body(),
    headers: { "content-type": before.headers()["content-type"] ?? "" },
  };
  try {
    const page = await admin.newPage();
    await page.goto("/admin/general");
    const company = page.getByRole("region", { name: "Company", exact: true });
    await company.getByLabel("Brand name", { exact: true }).fill(brand);
    await company.getByRole("button", { name: "Save", exact: true }).click();
    await expect(company.getByText("Saved.")).toBeVisible();
    await page.getByLabel("Logo file").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: PIXEL,
    });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Logo" }).getByRole("img", {
        name: brand,
      }),
    ).toBeVisible();

    const made = await admin.request.post("/api/v1/admin/people/invites", {
      headers: { origin: BASE },
      data: { emails: [email], role: "viewer", delivery: "link" },
    });
    expect(made.status(), await made.text()).toBe(200);
    const { invites } = (await made.json()) as { invites: { link: string }[] };
    const link = invites[0]?.link;
    if (link === undefined) throw new Error("The invite answered no link.");

    for (const width of [390, 1440])
      for (const colorScheme of ["light", "dark"] as const)
        await test.step(`${String(width)} wide in ${colorScheme}`, async () => {
          const guest = await browser.newContext({
            baseURL: BASE,
            viewport: { width, height: 900 },
            colorScheme,
          });
          try {
            await branded(guest, "/sign-in", `Sign in to ${brand}`, brand);
            await branded(guest, link, `Admin invited you to ${brand}`, brand);
          } finally {
            await guest.close();
          }
        });
  } finally {
    await forget(admin.request, email);
    const named = await admin.request.put(NAME, {
      headers: { origin: BASE },
      data: { value: name },
    });
    expect(named.status(), await named.text()).toBe(200);
    if (logo) await changed(admin.request, "put", LOGO, logo);
    else await changed(admin.request, "delete", LOGO);
    await admin.close();
  }
});
