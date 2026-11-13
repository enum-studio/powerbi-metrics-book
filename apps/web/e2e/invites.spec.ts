import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import {
  test as base,
  contextAs,
  devStackUrl,
  expect,
  forget,
  getJson,
  UNINVITED,
} from "./fixtures.ts";
import { continueWithMicrosoft, mailTo } from "./microsoft.ts";

const BASE = devStackUrl();
const DEV_STACK = fileURLToPath(
  new URL("../../../scripts/dev-stack.mjs", import.meta.url),
);
const SUBJECT = "Admin invited you to Power BI Metrics Book";
const ENDED =
  "This invite is no longer valid. Sign in, or ask an admin for a new one.";
const unique = () => randomUUID().slice(0, 8);

/** A signed-out browser beside the admin's, where a person opens the links they were sent. */
const test = base.extend<{ guest: BrowserContext }>({
  guest: async ({ browser }, use) => {
    const guest = await browser.newContext({ baseURL: BASE });
    await use(guest);
    await guest.close();
  },
});
test.use({ signedInAs: "admin" });

/** Invites one person from the Invite people dialog; the link the dialog shows, or the one the email carries. */
async function invite(
  page: Page,
  email: string,
  role: RegExp,
  delivery: "email" | "link",
): Promise<string> {
  await page.goto("/admin/people");
  await page
    .getByRole("button", { name: "Invite people", exact: true })
    .click();
  const form = page.getByRole("form", { name: "Invite people" });
  await form.getByLabel("Emails", { exact: true }).fill(email);
  await form.getByRole("radio", { name: role }).check();
  if (delivery === "link") {
    await form.getByRole("button", { name: /^Create invite link/ }).click();
    return (await form.getByRole("status").locator("pre").innerText()).trim();
  }
  const sent = (await mailTo(email)).length;
  await form.getByRole("button", { name: "Send invites" }).click();
  await expect(form.getByRole("status")).toHaveText("Invites sent.");
  await expect.poll(async () => (await mailTo(email)).length).toBe(sent + 1);
  const link = (await mailTo(email)).at(-1)?.link;
  if (link === undefined)
    throw new Error(`The invite to ${email} has no link.`);
  return link;
}

/** The Pending invites tab, once it has drawn its table or its empty line. */
async function pending(page: Page) {
  await page.goto("/admin/people");
  await page.getByRole("button", { name: /^Pending invites \(/ }).click();
  const table = page.getByRole("table", { name: "Pending invites" });
  await expect(table.or(page.getByText("No pending invites."))).toBeVisible();
  return table;
}

/** Opens an invite link in a new page, as a person clicking it does. */
async function opened(guest: BrowserContext, link: string) {
  const page = await guest.newPage();
  await page.goto(link);
  await expect(page).toHaveURL(`${BASE}/invite`);
  return page;
}

const rolesOf = async (page: Page) =>
  (await getJson<{ roles: string[] }>(page.request, "/api/v1/me")).roles;

/** The person's role on the Users tab, and their invite gone from Pending invites. */
async function joined(page: Page, email: string, role: string) {
  const table = await pending(page);
  await expect(table.getByRole("row", { name: new RegExp(email) })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /^Users \(/ }).click();
  await expect(page.getByLabel(`Role for ${email}`)).toHaveValue(role);
}

test("New link warns first and ends the shared link, and Revoke ends the new one", async ({
  page,
  context,
  guest,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: BASE,
  });
  const email = `link-${unique()}@sample.example`;
  const first = await invite(page, email, /^Viewer/, "link");
  const row = (await pending(page)).getByRole("row", {
    name: new RegExp(email),
  });
  await row.getByRole("button", { name: "New link", exact: true }).click();
  await expect(row).toContainText("The link you already shared stops working.");
  await row.getByRole("button", { name: "Copy new link", exact: true }).click();
  const shown = row.locator("pre");
  await expect(shown).toBeVisible();
  const second = (await shown.innerText()).trim();
  expect(second).not.toBe(first);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    second,
  );
  await expect((await opened(guest, first)).getByText(ENDED)).toBeVisible();
  await expect(
    (await opened(guest, second)).getByRole("heading", { level: 1 }),
  ).toHaveText(SUBJECT);

  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect((await opened(guest, second)).getByText(ENDED)).toBeVisible();
});

// Email delivery and password sign-in are the whole tenant's, so these run alone and put them back.
test.describe("invites by email and through Microsoft @tenant", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });
  const SETTINGS = ["email.from", "sign_in.email_password"] as const;
  let before: unknown[] = [];

  test.beforeAll(async ({ browser }) => {
    const admin = await contextAs(browser, "admin");
    const read = admin.request;
    try {
      before = await Promise.all(
        SETTINGS.map(async (key) => {
          const path = `/api/v1/admin/settings/${key}`;
          return (await getJson<{ value: unknown }>(read, path)).value;
        }),
      );
      execFileSync("node", [DEV_STACK, "email-password"]);
      // The sign-in config serves what it read for up to 30 seconds.
      const config = () =>
        getJson<{ email_password: boolean }>(read, "/api/auth/config");
      await expect
        .poll(async () => (await config()).email_password, { timeout: 45_000 })
        .toBe(true);
      await forget(read, UNINVITED.email);
    } finally {
      await admin.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const admin = await contextAs(browser, "admin");
    try {
      await forget(admin.request, UNINVITED.email);
      for (const [i, key] of SETTINGS.entries()) {
        const restored = await admin.request.put(
          `/api/v1/admin/settings/${key}`,
          { headers: { origin: BASE }, data: { value: before[i] } },
        );
        expect(restored.status(), await restored.text()).toBe(200);
      }
    } finally {
      await admin.close();
    }
  });

  test("an emailed invite names who sent it, and accepting through Microsoft gives its role", async ({
    page,
    guest,
  }) => {
    const link = await invite(page, UNINVITED.email, /^Curator/, "email");
    const mail = (await mailTo(UNINVITED.email)).at(-1);
    expect(mail?.subject).toBe(SUBJECT);
    expect(mail?.text).toContain(`${SUBJECT} as a Curator.`);
    expect(mail?.text).toMatch(/This invite expires on [^.\n]+\./);
    expect(new URL(link).pathname).toBe("/invite");
    const person = await opened(guest, link);
    await expect(person.getByRole("heading", { level: 1 })).toHaveText(SUBJECT);
    await expect(person.getByText("You will join as a Curator.")).toBeVisible();
    await expect(
      person.getByText(`Sign in as ${UNINVITED.email}.`),
    ).toBeVisible();
    await expect(
      person.getByText(/^This invite expires on .+\.$/),
    ).toBeVisible();
    await expect(
      person.getByRole("button", { name: "Set a password" }),
    ).toBeVisible();
    await continueWithMicrosoft(person, UNINVITED.object_id, "/");
    expect(await rolesOf(person)).toContain("curator");
    await joined(page, UNINVITED.email, "curator");
    await forget(page.request, UNINVITED.email);
  });

  test("a link invite offers no password, and accepting through Microsoft works", async ({
    page,
    guest,
  }) => {
    const link = await invite(page, UNINVITED.email, /^Viewer/, "link");
    expect(new URL(link).pathname).toBe("/invite");
    const person = await opened(guest, link);
    await expect(person.getByRole("heading", { level: 1 })).toHaveText(SUBJECT);
    await expect(person.getByText("You will join as a Viewer.")).toBeVisible();
    await expect(
      person.getByRole("button", { name: "Continue with Microsoft" }),
    ).toBeVisible();
    await expect(
      person.getByRole("button", { name: "Set a password" }),
    ).toHaveCount(0);
    await expect(person.getByLabel(/password/i)).toHaveCount(0);
    await continueWithMicrosoft(person, UNINVITED.object_id, "/");
    expect(await rolesOf(person)).toContain("viewer");
    await joined(page, UNINVITED.email, "viewer");
  });

  test("Resend emails a second link that works, and the first stops working", async ({
    page,
    guest,
  }) => {
    const email = `resend-${unique()}@sample.example`;
    try {
      const first = await invite(page, email, /^Viewer/, "email");
      await (
        await pending(page)
      )
        .getByRole("row", { name: new RegExp(email) })
        .getByRole("button", { name: "Resend", exact: true })
        .click();
      await expect.poll(async () => (await mailTo(email)).length).toBe(2);
      const second = (await mailTo(email))[1]?.link;
      if (second === undefined)
        throw new Error("The second email has no link.");
      expect(second).not.toBe(first);
      await expect(
        (await opened(guest, second)).getByRole("heading", { level: 1 }),
      ).toHaveText(SUBJECT);
      await expect((await opened(guest, first)).getByText(ENDED)).toBeVisible();
    } finally {
      await forget(page.request, email);
    }
  });
});
