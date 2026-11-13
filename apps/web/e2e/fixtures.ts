import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  test as base,
  type Page,
} from "@playwright/test";

export { expect } from "@playwright/test";

let stackUrl: string | undefined;

/** The dev stack's api for this checkout (pnpm dev:up), which serves the built SPA. */
export function devStackUrl(): string {
  stackUrl ??= execFileSync(
    "node",
    [
      fileURLToPath(new URL("../../../scripts/dev-stack.mjs", import.meta.url)),
      "url",
    ],
    { encoding: "utf8" },
  ).trim();
  return stackUrl;
}

/** The first lane is a drawer below 1024px: this opens it there, and does nothing on a wider screen, where it is always open. */
export async function openColumn(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByRole("button", { name: "Open the menu" }).click();
}

/** Closes the drawer openColumn opened, so the page is reachable again. */
export async function closeColumn(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByRole("button", { name: "Close the menu" }).click();
}

/** Reaches Settings' pages: a link that opens the second lane, or in the drawer a row that folds them out. */
export async function openSettings(page: Page): Promise<void> {
  const main = page.getByRole("navigation", { name: "Main" });
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await main.getByRole("button", { name: "Settings", exact: true }).click();
  else await main.getByRole("link", { name: "Settings", exact: true }).click();
}

/**
 * Unfolds the tree's datasets, which stay folded until the reader opens them
 * or is on one: Datasets, then every workspace, so each dataset has its row.
 */
export async function openDatasets(page: Page): Promise<void> {
  const fold = page
    .getByRole("navigation", { name: "Catalog", exact: true })
    .getByRole("button", { name: "Datasets", exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false")
    await fold.click();
  const workspaces = fold.locator("xpath=..").locator(":scope > div > button");
  await expect(workspaces.first()).toBeVisible();
  const folded = workspaces.and(page.locator('[aria-expanded="false"]'));
  while ((await folded.count()) > 0) await folded.first().click();
}

/** The sample tenant's people a screen's tests sign in as, each with the role named. */
export const PEOPLE = {
  admin: "admin@sample.example",
  curator: "analyst@sample.example",
  viewer: "viewer@sample.example",
} as const;

/** Object ids of the sample tenant's people (packages/powerbi-mock/src/sample/tenant.ts). */
export const OBJECT_ID: Record<string, string> = {
  "admin@sample.example": "a0000000-0000-4000-8000-000000000001",
  "analyst@sample.example": "a0000000-0000-4000-8000-000000000002",
  "viewer@sample.example": "a0000000-0000-4000-8000-000000000003",
  "leader@sample.example": "a0000000-0000-4000-8000-000000000004",
  "app-reader@sample.example": "a0000000-0000-4000-8000-000000000007",
  "sales-viewer@sample.example": "a0000000-0000-4000-8000-000000000008",
};

/** The roles the specs start from, each signed in once by the sessions project (sessions.setup.ts). */
export type Role = keyof typeof PEOPLE;

/** Where the sessions project saves a role's storage state, under test-results. */
export const sessionFile = (role: Role): string =>
  fileURLToPath(
    new URL(`../test-results/sessions/${role}.json`, import.meta.url),
  );

/**
 * The specs' test: `test.use({ signedInAs: "admin" })` starts each page from
 * that role's saved session, so a spec that is not about signing in never
 * signs in. Without it the browser starts signed out.
 */
export const test = base.extend<{ signedInAs: Role | null }>({
  signedInAs: [null, { option: true }],
  storageState: async ({ signedInAs, storageState }, use) => {
    await use(signedInAs === null ? storageState : sessionFile(signedInAs));
  },
});

/** A second browser context as another role, for a test that needs two people at once or a screen of its own. */
export const contextAs = (
  browser: Browser,
  role: Role,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> =>
  browser.newContext({
    ...options,
    baseURL: devStackUrl(),
    storageState: sessionFile(role),
  });

/**
 * Gives a person a role through a request context signed in as the admin. A
 * role they already hold answers 409 and is kept.
 */
export async function grantRole(
  admin: APIRequestContext,
  email: string,
  role: string,
): Promise<void> {
  const assigned = await admin.post("/api/v1/admin/roles", {
    headers: { origin: devStackUrl() },
    data: { role, subject_kind: "person", subject: email },
  });
  if (assigned.status() !== 201 && assigned.status() !== 409)
    throw new Error(
      `Assigning ${role} to ${email} answered ${String(assigned.status())}: ${await assigned.text()}`,
    );
}

/**
 * A session of its own through the dev sign-in, for a test whose subject is
 * the session itself: signing out, a passkey, the setup's first admin. Every
 * other test starts from a saved session (signedInAs).
 */
export async function signInAs(page: Page, email: string): Promise<void> {
  await devSignIn(page.context().request, email);
}

/**
 * With the person's object id, so the user has the Microsoft account a
 * sign-in through the mock's Microsoft finds later.
 */
export async function devSignIn(
  request: APIRequestContext,
  email: string,
): Promise<void> {
  const object_id = OBJECT_ID[email];
  if (object_id === undefined)
    throw new Error(`Add ${email}'s object id to OBJECT_ID in e2e/fixtures.ts`);
  const response = await request.post("/api/auth/dev/sign-in", {
    headers: { origin: devStackUrl() },
    data: { email, object_id },
  });
  if (!response.ok())
    throw new Error(
      `The dev sign-in of ${email} answered ${String(response.status())}: ${await response.text()}. Is the dev stack up (pnpm dev:up)?`,
    );
}

/** The sample tenant's one person no test gives a role, so only an invite lets them in (packages/powerbi-mock/src/sample/tenant.ts). */
export const UNINVITED = {
  email: "outsider@sample.example",
  object_id: "a0000000-0000-4000-8000-000000000005",
} as const;

/** What a GET answers, as the caller expects it. */
export async function getJson<T>(
  request: APIRequestContext,
  path: string,
): Promise<T> {
  return (await (await request.get(path)).json()) as T;
}

/** Sends a change the admin api answers 204 to, and fails with its answer when it does not. */
export async function changed(
  request: APIRequestContext,
  method: "post" | "put" | "delete",
  path: string,
  options: { data?: unknown; headers?: Record<string, string> } = {},
): Promise<void> {
  const headers = { origin: devStackUrl(), ...options.headers };
  const answer = await request[method](path, { ...options, headers });
  expect(answer.status(), await answer.text()).toBe(204);
}

/**
 * Takes a person a test let in back out, so the next run can invite them
 * again: their open invites, their user and the roles given to their email.
 */
export async function forget(
  admin: APIRequestContext,
  email: string,
): Promise<void> {
  const mine = (each: { email?: string; subject?: string | null }) =>
    each.email === email || each.subject === email;
  const { invites } = await getJson<{
    invites: { id: string; email: string }[];
  }>(admin, "/api/v1/admin/people/invites");
  for (const { id } of invites.filter(mine))
    await changed(admin, "delete", `/api/v1/admin/people/invites/${id}`);
  const { people } = await getJson<{
    people: { id: string; email: string; status: string }[];
  }>(admin, "/api/v1/admin/people");
  const person = people.find(mine);
  if (person?.status === "active")
    await changed(
      admin,
      "post",
      `/api/v1/admin/people/${person.id}/deactivate`,
    );
  if (person !== undefined)
    await changed(admin, "delete", `/api/v1/admin/people/${person.id}`);
  // A role given to someone who never signed in has no user to go with.
  const { roles } = await getJson<{
    roles: { id: string; subject_kind: string; subject: string | null }[];
  }>(admin, "/api/v1/admin/roles");
  for (const { id } of roles.filter(
    (each) => each.subject_kind === "person" && mine(each),
  ))
    await changed(admin, "delete", `/api/v1/admin/roles/${id}`);
}
