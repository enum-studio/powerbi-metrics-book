import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Page } from "@playwright/test";
import {
  contextAs,
  devStackUrl,
  expect,
  openColumn,
  test,
} from "./fixtures.ts";
import { problemsOnPhones } from "./phone.ts";

const BASE = devStackUrl();
const MOCK = `http://127.0.0.1:${String(Number(new URL(BASE).port) + 1)}`;
const SETTING = "/api/v1/admin/settings/sign_in.email_password";
const SENT =
  "If that email has an account, a link to set a new password is on its way.";

async function emailLink(page: Page, email: string, subject: string) {
  let link: string | undefined;
  await expect
    .poll(async () => {
      const response = await page.request.get(`${MOCK}/_mock/outbox`);
      expect(response.status()).toBe(200);
      const outbox = (await response.json()) as {
        to: string;
        subject: string;
        text: string;
      }[];
      link = outbox
        .findLast((mail) => mail.to === email && mail.subject === subject)
        ?.text.match(/https?:\/\/\S+/)?.[0];
      return link !== undefined;
    })
    .toBe(true);
  if (link === undefined)
    throw new Error("The mock received no password link.");
  return link;
}

async function setPassword(page: Page, password: string) {
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Set password", exact: true }).click();
}

// This setting changes sign-in for the whole tenant, so the flow runs alone and restores it.
test("an admin invites a person who sets, uses and resets a password @tenant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const admin = await contextAs(browser, "admin");
  const page = await admin.newPage();
  const before = (
    (await (await admin.request.get(SETTING)).json()) as { value: boolean }
  ).value;
  execFileSync("node", [
    fileURLToPath(new URL("../../../scripts/dev-stack.mjs", import.meta.url)),
    "email-password",
  ]);
  try {
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get("/api/auth/config")).json()) as {
              email_password: boolean;
            }
          ).email_password,
        { timeout: 45_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (
            await page.request.post("/api/auth/invites/accept", {
              headers: { origin: BASE },
              data: {
                token: "unused-sample-link",
                password: "sample readiness password",
              },
            })
          ).status(),
        { timeout: 45_000, intervals: [10_000] },
      )
      .toBe(400);
    for (const width of [390, 1440])
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        const guest = await browser.newContext({
          baseURL: BASE,
          viewport: { width, height: 900 },
          colorScheme,
        });
        try {
          const person = await guest.newPage();
          await page.goto("/admin/people");
          await expect(
            page.getByRole("button", { name: "Invite people", exact: true }),
          ).toBeVisible();
          await person.goto("/sign-in");
          await expect(
            person.getByLabel("Password", { exact: true }),
          ).toBeVisible();
          await person.goto("/forgot-password");
          await expect(
            person.getByLabel("Email", { exact: true }),
          ).toBeVisible();
          for (const kind of ["invite", "reset"]) {
            await person.goto(
              `/set-password?kind=${kind}#token=sample-preview-link`,
            );
            await expect(
              person.getByLabel("New password", { exact: true }),
            ).toBeVisible();
            await expect(person).toHaveURL(`${BASE}/set-password?kind=${kind}`);
          }
        } finally {
          await guest.close();
        }
      }
    await test.step("invite and reset", async () => {
      const email = `invite-${randomUUID().slice(0, 8)}@sample.example`;
      const guest = await browser.newContext({ baseURL: BASE });
      try {
        const person = await guest.newPage();
        await test.step("accept an invite and sign in", async () => {
          await page.goto("/admin/people");
          await page
            .getByRole("button", { name: "Invite people", exact: true })
            .click();
          const invite = page.getByRole("form", { name: "Invite people" });
          await invite.getByLabel("Emails", { exact: true }).fill(email);
          await invite.getByRole("radio", { name: /^Viewer/ }).check();
          await invite.getByRole("button", { name: "Send invites" }).click();
          await expect(invite.getByRole("status")).toHaveText("Invites sent.");
          const invited = await emailLink(
            page,
            email,
            "Admin invited you to Power BI Metrics Book",
          );
          expect(new URL(invited).pathname).toBe("/invite");
          expect(new URL(invited).searchParams.has("token")).toBe(false);
          await person.goto(invited);
          await expect(person).toHaveURL(`${BASE}/invite`);
          await person
            .getByRole("button", { name: "Set a password", exact: true })
            .click();
          await expect(person).toHaveURL(`${BASE}/set-password?kind=invite`);
          await expect(
            person.getByLabel("New password", { exact: true }),
          ).toBeVisible();
          expect(await problemsOnPhones(person)).toEqual([]);
          await person
            .getByLabel("New password", { exact: true })
            .fill("sample first password");
          await person.getByLabel("Confirm password").fill("sample other one");
          await person
            .getByRole("button", { name: "Set password", exact: true })
            .click();
          await expect(
            person.getByText("The passwords do not match."),
          ).toBeVisible();
          expect(await problemsOnPhones(person)).toEqual([]);
          await setPassword(person, "sample first password");
          await expect(person).toHaveURL(`${BASE}/`);
          await openColumn(person);
          await expect(
            person.getByRole("region", { name: "Your account" }),
          ).toContainText(email);
          await guest.clearCookies();
          await person.goto("/sign-in");
          await person.getByLabel("Email", { exact: true }).fill(email);
          await person
            .getByLabel("Password", { exact: true })
            .fill("sample first password");
          await person
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await expect(person).toHaveURL(`${BASE}/`);
        });
        await test.step("reset a password and sign in", async () => {
          await guest.clearCookies();
          await person.goto("/forgot-password");
          await person.getByLabel("Email", { exact: true }).fill(email);
          await person
            .getByRole("button", { name: "Send password link" })
            .click();
          await expect(person.getByRole("status")).toHaveText(SENT);
          const reset = await emailLink(page, email, "Reset your password");
          expect(new URL(reset).searchParams.get("kind")).toBe("reset");
          expect(new URL(reset).searchParams.has("token")).toBe(false);
          await person.goto(reset);
          await expect(person).toHaveURL(`${BASE}/set-password?kind=reset`);
          await expect(
            person.getByLabel("New password", { exact: true }),
          ).toBeVisible();
          expect(await problemsOnPhones(person)).toEqual([]);
          await setPassword(person, "sample second password");
          await expect(person).toHaveURL(/\/sign-in\?password=set$/);
          await expect(person.getByRole("status")).toHaveText(
            "Your password is set. Sign in with it.",
          );
          await person.getByLabel("Email", { exact: true }).fill(email);
          await person
            .getByLabel("Password", { exact: true })
            .fill("sample second password");
          await person
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await expect(person).toHaveURL(`${BASE}/`);
        });
      } finally {
        await guest.close();
      }
    });
  } finally {
    const restored = await admin.request.put(SETTING, {
      headers: { origin: BASE },
      data: { value: before },
    });
    expect(restored.status()).toBe(200);
    await admin.close();
  }
});
