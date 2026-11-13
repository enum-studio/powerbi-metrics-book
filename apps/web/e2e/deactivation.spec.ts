import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  contextAs,
  devStackUrl,
  expect,
  forget,
  grantRole,
  test,
} from "./fixtures.ts";

const BASE = devStackUrl();
const DEACTIVATED =
  "An admin has deactivated your account. Ask an admin to reactivate it.";

/** Signs in on the sign-in page's Development sign-in, as a person on the dev stack does. */
async function devSignIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Development sign-in").fill(email);
  await page.getByRole("button", { name: "Sign in as this person" }).click();
}

/** The person's row on the Users tab, with its Actions menu open. */
async function actionsFor(page: Page, email: string) {
  await page.goto("/admin/people");
  await page.getByRole("button", { name: /^Users \(/ }).click();
  const row = page
    .getByRole("table", { name: "Users", exact: true })
    .getByRole("row", { name: new RegExp(email) });
  await row.getByLabel(`Actions for ${email}`).click();
  return row;
}

// A second admin changes who administers for every test, so this runs alone and removes them after.
test("a deactivated admin is signed out and refused, their invites end, and Reactivate lets them back as admin @tenant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const id = randomUUID().slice(0, 8);
  const email = `deactivate-${id}@sample.example`;
  const invited = `invited-by-${id}@sample.example`;
  const admin = await contextAs(browser, "admin");
  const person = await browser.newContext({ baseURL: BASE });
  try {
    const page = await admin.newPage();
    await grantRole(admin.request, email, "admin");
    const theirs = await person.newPage();
    await devSignIn(theirs, email);
    await expect(theirs).toHaveURL(`${BASE}/`);
    const sent = await theirs.request.post("/api/v1/admin/people/invites", {
      headers: { origin: BASE },
      data: { emails: [invited], role: "viewer", delivery: "link" },
    });
    expect(sent.status(), await sent.text()).toBe(200);
    await page.goto("/admin/people");
    await page.getByRole("button", { name: /^Pending invites \(/ }).click();
    await expect(page.getByText(invited)).toBeVisible();

    await test.step("deactivate", async () => {
      const row = await actionsFor(page, email);
      await row
        .getByRole("button", { name: "Deactivate", exact: true })
        .click();
      await expect(row).toContainText(
        "This ends their sessions and disconnects Power BI, MCP and CLI.",
      );
      await row
        .getByRole("button", { name: "Deactivate", exact: true })
        .click();
      await expect(row.getByRole("cell").nth(2)).toHaveText("Deactivated");
      await page.getByRole("button", { name: /^Pending invites \(/ }).click();
      await expect(
        page
          .getByRole("table", { name: "Pending invites" })
          .or(page.getByText("No pending invites.")),
      ).toBeVisible();
      await expect(page.getByText(invited)).toHaveCount(0);
    });

    await test.step("their open page is signed out, and signing in is refused", async () => {
      expect((await theirs.request.get("/api/v1/me")).status()).toBe(401);
      await theirs.reload();
      await expect(theirs).toHaveURL(/\/sign-in/);
      await devSignIn(theirs, email);
      await expect(theirs.getByText(DEACTIVATED)).toBeVisible();
      expect((await theirs.request.get("/api/v1/me")).status()).toBe(401);
    });

    await test.step("reactivate", async () => {
      const row = await actionsFor(page, email);
      await row
        .getByRole("button", { name: "Reactivate", exact: true })
        .click();
      await expect(row.getByRole("cell").nth(2)).toHaveText("Active");
      await devSignIn(theirs, email);
      await expect(theirs).toHaveURL(`${BASE}/`);
      const me = (await (await theirs.request.get("/api/v1/me")).json()) as {
        email: string;
        roles: string[];
      };
      expect(me.email).toBe(email);
      expect(me.roles).toContain("admin");
    });
  } finally {
    await forget(admin.request, email);
    await person.close();
    await admin.close();
  }
});
