import { randomUUID } from "node:crypto";
import type { Page, PlaywrightWorkerArgs } from "@playwright/test";
import { devStackUrl, expect, PEOPLE, test } from "./fixtures.ts";

test.use({ signedInAs: "admin" });

const unique = () => randomUUID().slice(0, 8);

/**
 * Signs a new person in through the dev sign-in. Like anyone not in the
 * tenant, they get in only with a role of their own, so the admin gives them
 * viewer first. Returns their session.
 */
async function newPerson(
  page: Page,
  playwright: PlaywrightWorkerArgs["playwright"],
  email: string,
) {
  const origin = devStackUrl();
  const given = await page.request.post("/api/v1/admin/roles", {
    headers: { origin },
    data: { role: "viewer", subject_kind: "person", subject: email },
  });
  expect(given.status(), await given.text()).toBe(201);
  const person = await playwright.request.newContext({ baseURL: origin });
  const signedIn = await person.post("/api/auth/dev/sign-in", {
    headers: { origin },
    data: { email },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return person;
}
const assignments = (page: Page) =>
  page.getByRole("table", { name: "Role assignments", exact: true });
const people = (page: Page) =>
  page.getByRole("table", { name: "Users", exact: true });
/** Opens the person's side panel from their row in the Users tab. */
async function panelOf(page: Page, email: string) {
  await page.getByRole("button", { name: /^Users \(/ }).click();
  await people(page)
    .getByRole("row", { name: new RegExp(email) })
    .getByRole("button", { name: new RegExp(email) })
    .click();
  return page.getByRole("dialog");
}
const groupsTab = (page: Page) =>
  page.getByRole("button", { name: "Groups and domains", exact: true });
const region = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("a new key shows once, and after a reload only its prefix", async ({
  page,
}) => {
  const name = `sa_${unique()}`;
  await page.goto("/admin/service-accounts");
  const create = page.getByRole("form", { name: "Create a service account" });
  await create.getByLabel("Name").fill(name);
  await create.getByLabel("Owner email").fill(PEOPLE.admin);
  await create.getByRole("button", { name: "Create service account" }).click();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("30 days");

  await row.getByRole("button", { name: `API keys for ${name}` }).click();
  await region(page, `API keys for ${name}`)
    .getByRole("button", { name: "Make a key" })
    .click();
  const shown = page.getByRole("region", { name: "New key" });
  await expect(shown).toContainText("This key will not be shown again.");
  const key = await shown.getByLabel("The new key").inputValue();
  expect(key.length).toBeGreaterThan(20);
  await expect(
    shown.getByRole("button", { name: "Copy the key" }),
  ).toBeVisible();

  await page.reload();
  await page
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("button", { name: `API keys for ${name}` })
    .click();
  const keys = page.getByRole("table", { name: `API keys for ${name}` });
  // The table shows how the key starts: pbmb_sk_, a few characters of its random part, then an ellipsis.
  const shownKey = await keys.getByRole("cell").first().innerText();
  const prefix = /^pbmb_sk_(.+)…$/.exec(shownKey)?.[1];
  expect(prefix, shownKey).toBeDefined();
  expect(key.startsWith(`pbmb_sk_${prefix ?? ""}`)).toBe(true);
  expect(shownKey.length).toBeLessThan(key.length);
  await expect(page.getByText(key)).toHaveCount(0);
  await expect(page.getByLabel("The new key")).toHaveCount(0);

  await page.getByRole("button", { name: `Disable ${name}` }).click();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText(
    "Disabled",
  );
});

test("a role given to an email domain shows in each person's roles, and revoking it takes it away", async ({
  page,
  playwright,
}) => {
  const domain = `d${unique()}.example`;
  const email = `person@${domain}`;
  await (await newPerson(page, playwright, email)).dispose();

  await page.goto("/admin/people");
  await groupsTab(page).click();
  const add = page.getByRole("form", { name: "Add a role assignment" });
  await add.getByLabel("Role").selectOption("curator");
  await add.getByLabel("Given to").selectOption("email_domain");
  await add.getByLabel("Domain").fill(domain);
  await add.getByRole("button", { name: "Add assignment" }).click();

  const assigned = assignments(page).getByRole("row", {
    name: new RegExp(`curator.*${domain}`),
  });
  await expect(assigned).toContainText(PEOPLE.admin);
  const panel = await panelOf(page, email);
  await expect(panel).toContainText(`Curator from Everyone at ${domain}`);
  await panel.getByRole("button", { name: "Close" }).click();

  await groupsTab(page).click();
  await assigned.getByRole("button", { name: /^Revoke curator/ }).click();
  await expect(assigned).toHaveCount(0);
  await expect(await panelOf(page, email)).not.toContainText("Curator");
});

// The last-admin rule itself is held by services/admin/people.test.ts, with another admin acting.
test("revoking your own admin assignment is refused, with the reason", async ({
  page,
}) => {
  await page.goto("/admin/people");
  await groupsTab(page).click();
  const admin = page
    .getByRole("table", { name: "Role assignments" })
    .getByRole("row", { name: new RegExp(`admin.*${PEOPLE.admin}`) });
  await expect(admin).toContainText("The last admin.");
  await admin.getByRole("button", { name: /^Revoke admin/ }).click();
  await expect(page.getByRole("alert")).toContainText(
    "You cannot change your own role. Ask another admin.",
  );
  await expect(admin).toBeVisible();
});

// Once: allowing a device code looks the code up, and the api answers five
// lookups per address in ten minutes for every project together (access.spec).
test("an admin revokes a person's CLI grant in their side panel, and it shows none @once", async ({
  page,
  playwright,
}) => {
  const email = `cli-${unique()}@sample.example`;
  const origin = devStackUrl();
  const person = await newPerson(page, playwright, email);
  // The CLI's device flow: the CLI asks for a code, the person allows it in the browser.
  const started = await person.post("/api/auth/device/code", {
    headers: { origin },
    form: {
      client_id: "pbmb-cli",
      scope: "api offline_access",
      resource: `${origin}/api/v1`,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const { user_code } = (await started.json()) as { user_code: string };
  const allowed = await person.post("/api/v1/oauth/device", {
    headers: { origin },
    data: { user_code, allow: true },
  });
  expect(allowed.status(), await allowed.text()).toBe(204);
  await person.dispose();

  await page.goto("/admin/people");
  const panel = await panelOf(page, email);
  await expect(panel).toContainText("pbmb, the command line");
  await expect(panel).toContainText("CLI, since");
  await panel
    .getByRole("button", { name: `Revoke pbmb, the command line for ${email}` })
    .click();
  await expect(panel).not.toContainText("pbmb, the command line");
  await expect(panel).toContainText("None");
});

test("the audit log shows what this test did, filtered by action and by person", async ({
  page,
}) => {
  // Its own events, named by a marker no other run has, so nothing left by another test or run is read.
  const marker = unique();
  const origin = devStackUrl();
  const send = async (path: string, data: object) => {
    const answer = await page.request.post(path, {
      headers: { origin },
      data,
    });
    expect(answer.status(), await answer.text()).toBe(201);
    return (await answer.json()) as { id: string };
  };
  const account = `audit_${marker}`;
  await send("/api/v1/admin/service-accounts", {
    name: account,
    owner_email: PEOPLE.admin,
    roles: ["viewer"],
  });
  await send(`/api/v1/admin/service-accounts/${account}/keys`, {
    expires_in_days: 1,
  });
  const assigned = await send("/api/v1/admin/roles", {
    role: "viewer",
    subject_kind: "person",
    subject: `audit-${marker}@sample.example`,
  });
  const revoked = await page.request.delete(
    `/api/v1/admin/roles/${assigned.id}`,
    { headers: { origin } },
  );
  expect(revoked.status()).toBe(204);

  await page.goto("/admin/audit");
  const filter = page.getByRole("form", { name: "Filter the audit log" });
  const log = page.getByRole("table", { name: "Audit log" });
  for (const [action, resource] of [
    ["service_account.create", account],
    ["service_account.create_key", account],
    ["admin.role.assign", assigned.id],
    ["admin.role.revoke", assigned.id],
  ] as const) {
    await filter.getByLabel("Action").fill(action);
    await filter.getByRole("button", { name: "Apply" }).click();
    const row = log.getByRole("row", { name: new RegExp(resource) });
    await expect(row).toContainText(action);
    await expect(row).toContainText(PEOPLE.admin);
    await expect(row).toContainText("Allowed");
  }

  await filter.getByLabel("Person").selectOption({ label: PEOPLE.admin });
  await filter.getByRole("button", { name: "Apply" }).click();
  await expect(
    log.getByRole("row", { name: new RegExp(assigned.id) }),
  ).toBeVisible();
  await filter.getByLabel("Action").fill("no.such.action");
  await filter.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByRole("heading", { name: "No events here" }),
  ).toBeVisible();
});

test("the conventions page reads the rules and gives the CLI commands to change them", async ({
  page,
}) => {
  await page.goto("/admin/conventions");
  await expect(
    page.getByRole("heading", { name: "Conventions", level: 1 }),
  ).toBeVisible();
  for (const command of [
    "pbmb conventions edit",
    "pbmb conventions set naming.case none",
    "pbmb conventions import conventions.yml",
  ])
    await expect(page.getByText(command, { exact: true })).toBeVisible();
  await expect(region(page, "Preset")).toContainText("Started from");
});
