import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  contextAs,
  devStackUrl,
  grantRole,
  OBJECT_ID,
  openColumn,
  PEOPLE,
  signInAs,
} from "./fixtures.ts";
import { authorize, REDIRECT } from "./oauth.ts";

// A round trip through the mock's Microsoft waits for the other projects' (asMicrosoft).
test.describe.configure({ timeout: 60_000 });

const BASE = devStackUrl();
const ORIGIN = { origin: BASE };
/** The mock's port is the api's plus one (scripts/dev-stack.mjs, devIdentity). */
const MOCK = `http://127.0.0.1:${String(Number(new URL(BASE).port) + 1)}`;

/** A person of its own per project, so the four projects' Power BI connections never meet. */
const OWN_PERSON: Record<string, string> = {
  "390-light": "leader@sample.example",
  "390-dark": "app-reader@sample.example",
  "1440-light": "sales-viewer@sample.example",
  "1440-dark": "viewer@sample.example",
};

/**
 * Runs a round trip through the mock's Microsoft as one person. Who the mock
 * signs in is one value for the whole mock, and the projects run at once, so
 * each round trip holds a lock (a directory) from choosing the person until
 * the browser is back on the api.
 */
async function asMicrosoft(email: string, work: () => Promise<void>) {
  const lock = join(tmpdir(), `pbmb-mock-acting-user-${new URL(BASE).port}`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      if (Date.now() > deadline)
        throw new Error(
          `Waited two minutes for ${lock}; remove it if no test run holds it.`,
        );
      await sleep(200);
    }
  }
  try {
    const acting = await fetch(`${MOCK}/_mock/acting-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_id: OBJECT_ID[email] }),
    });
    expect(acting.status, "the mock's acting user").toBe(204);
    await work();
  } finally {
    await rm(lock, { recursive: true });
  }
}

const onApi = (path: string) => (url: URL) =>
  url.origin === BASE && url.pathname === path;

async function signInWithMicrosoft(
  page: Page,
  email: string,
  path: string,
  landing: string,
) {
  await page.goto(path);
  await asMicrosoft(email, async () => {
    await page.getByRole("button", { name: "Continue with Microsoft" }).click();
    // The last step is the router's own redirect, which loads no page.
    await expect(page).toHaveURL(onApi(landing), { timeout: 20_000 });
  });
}

// The tests that sign in for real (Microsoft, consent, the device code) run
// once: every project's sign-ins count against one address's rate limit.
test("a Microsoft sign-in ignores an absolute next and lands on this site @once", async ({
  page,
}) => {
  const elsewhere: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "evil.example")
      elsewhere.push(request.url());
  });
  await signInWithMicrosoft(
    page,
    PEOPLE.admin,
    "/sign-in?next=https://evil.example/",
    "/",
  );
  await openColumn(page);
  await expect(
    page.getByRole("region", { name: "Your account" }).getByText(PEOPLE.admin),
  ).toBeVisible();
  expect(elsewhere).toEqual([]);
});

test("a Microsoft sign-in from a link into the catalog comes back to it @once", async ({
  page,
}) => {
  await signInWithMicrosoft(
    page,
    PEOPLE.admin,
    "/catalog/metrics/net_sales",
    "/catalog/metrics/net_sales",
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Net sales" }),
  ).toBeVisible();
});

test("a Microsoft sign-in returns to next @once", async ({ page }) => {
  await signInWithMicrosoft(
    page,
    PEOPLE.admin,
    "/sign-in?next=%2Fdevice",
    "/device",
  );
  await expect(
    page.getByRole("heading", { name: "Enter the code from your terminal" }),
  ).toBeVisible();
});

test("a refused sign-in says the page's own sentence, never the link's text", async ({
  page,
}) => {
  const hostile = "Your account is locked. Call +1 555 0100 to unlock it.";
  const linked = (error: string) =>
    `/sign-in?error=${error}&error_description=${encodeURIComponent(hostile)}`;
  await page.goto(linked("not_assigned"));
  await expect(page.getByRole("alert")).toHaveText(
    "You do not have access yet. Ask an admin of Power BI Metrics Book to invite you.",
  );
  await page.goto(linked("account_locked"));
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in did not finish. Try again, or ask one of this site's admins.",
  );
  await expect(page.getByText(hostile)).toHaveCount(0);
});

const PASSKEYS = "/api/v1/admin/settings/sign_in.passkeys";
let passkeysBefore: boolean | undefined;
test.afterEach(async ({ page }) => {
  if (passkeysBefore === undefined) return;
  await signInAs(page, PEOPLE.admin);
  const restored = await page.request.put(PASSKEYS, {
    headers: ORIGIN,
    data: { value: passkeysBefore },
  });
  expect(restored.status()).toBe(200);
  passkeysBefore = undefined;
});

// It turns passkeys on for the whole stack, so it runs alone.
test("a passkey registered once signs the person in @tenant", async ({
  page,
}) => {
  // Turning passkeys on takes up to 30 seconds to reach Better Auth.
  test.setTimeout(90_000);
  await signInAs(page, PEOPLE.admin);
  const before = await page.request.get(PASSKEYS);
  passkeysBefore = ((await before.json()) as { value: boolean }).value;
  const on = await page.request.put(PASSKEYS, {
    headers: ORIGIN,
    data: { value: true },
  });
  expect(on.status(), await on.text()).toBe(200);
  // Better Auth and the sign-in page's config both read settings again within 30 seconds.
  const within = { timeout: 45_000, intervals: [1000] };
  await expect
    .poll(
      async () =>
        (
          await page.request.get("/api/auth/passkey/generate-register-options")
        ).status(),
      within,
    )
    .toBe(200);
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get("/api/auth/config")).json()) as {
            passkeys: boolean;
          }
        ).passkeys,
      within,
    )
    .toBe(true);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto("/settings/connections");
  await page.getByRole("tab", { name: "Passkeys" }).click();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added.")).toBeVisible();
  const { credentials } = await cdp.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials).toHaveLength(1);

  await page.context().clearCookies();
  await page.goto("/sign-in?next=%2Fdevice");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  // Signed in on the page itself, so the router moves on without a page load.
  await expect(page).toHaveURL(`${BASE}/device`);
  await expect(page.getByRole("banner").getByText(PEOPLE.admin)).toBeVisible();
});

/** The client's redirect URI, answered in place of the client: where the consent sent the browser. */
async function answerAt(page: Page, button: "Allow" | "Deny"): Promise<URL> {
  await page.route(`${new URL(REDIRECT).origin}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "the client",
    }),
  );
  const arrived = page.waitForRequest((request) =>
    request.url().startsWith(REDIRECT),
  );
  await page.getByRole("button", { name: button, exact: true }).click();
  return new URL((await arrived).url());
}

// Registering is limited to 10 a minute per address, so one client serves Allow and the revoke.
test("consent names the client and its redirect host, Allow returns a code, and the grant is revoked on connections @once", async ({
  page,
}) => {
  await signInAs(page, PEOPLE.admin);
  const { state, name } = await authorize(page);
  // A registered client's name is only claimed, and the heading says so.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `${name} (name not checked)`,
  );
  await expect(page.getByText(`as ${PEOPLE.admin}`)).toBeVisible();
  await expect(page.getByText("Nothing checks this app's name")).toBeVisible();
  await expect(page.getByTestId("redirect-host")).toHaveText(
    "https://client.sample.example",
  );
  await expect(page.getByText("It will not be able to")).toBeVisible();
  const back = await answerAt(page, "Allow");
  expect(back.searchParams.get("code")).toMatch(/.+/);
  expect(back.searchParams.get("state")).toBe(state);
  await revokeOnConnections(page, name);
});

test("Deny returns access_denied to the client @once", async ({ page }) => {
  await signInAs(page, PEOPLE.admin);
  const { state } = await authorize(page);
  const back = await answerAt(page, "Deny");
  expect(back.searchParams.get("error")).toBe("access_denied");
  expect(back.searchParams.get("code")).toBeNull();
  expect(back.searchParams.get("state")).toBe(state);
});

test("an expired or forged consent request says so @once", async ({ page }) => {
  await signInAs(page, PEOPLE.admin);
  await page.goto("/oauth/consent?client_id=forged&sig=forged");
  await expect(
    page.getByRole("heading", { name: "This request expired" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
  // Opened directly, there was never a request: a different sentence.
  await page.goto("/oauth/consent");
  await expect(
    page.getByRole("heading", { name: "No app is asking to connect" }),
  ).toBeVisible();
});

async function tokenFor(device_code: string) {
  const form = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code,
    client_id: "pbmb-cli",
  };
  for (let round = 0; round < 4; round += 1) {
    const answer = await fetch(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const body = (await answer.json()) as Record<string, unknown>;
    if (body.error !== "slow_down") return body;
    await sleep(5_000);
  }
  throw new Error("The token endpoint kept answering slow_down.");
}

test("a code in the link is never filled in on /device @once", async ({
  page,
}) => {
  await signInAs(page, PEOPLE.admin);
  await page.goto("/device?user_code=ABCD-EFGH");
  await expect(page.getByLabel("Code from your terminal")).toHaveValue("");
  await expect(
    page.getByText("The link you followed carried a code."),
  ).toBeVisible();
});

/**
 * The api answers five code lookups per address in ten minutes (a phishing
 * defence), and every project's browser reaches the dev stack from the same
 * address, so the lookups run once, in the "once" project.
 */
test("a device code typed on /device and allowed gives the CLI its tokens @once", async ({
  page,
}) => {
  await signInAs(page, PEOPLE.admin);
  const started = await fetch(`${BASE}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "pbmb-cli",
      scope: "api offline_access",
      resource: `${BASE}/api/v1`,
    }),
  });
  expect(started.status).toBe(200);
  const { user_code, device_code } = (await started.json()) as {
    user_code: string;
    device_code: string;
  };

  await page.goto("/device");
  const code = page.getByLabel("Code from your terminal");
  await code.fill(user_code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("device-code")).toHaveText(user_code);
  await expect(page.getByText(/^Started .+ from /)).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The command line is signed in" }),
  ).toBeVisible();

  const tokens = await tokenFor(device_code);
  expect(tokens).toMatchObject({ token_type: "Bearer" });
  expect(typeof tokens.access_token).toBe("string");
  expect(typeof tokens.refresh_token).toBe("string");

  // The CLI's first call marks the home page's last step done, and with every
  // step done Home shows no setup notice (the steps themselves: home.test.tsx).
  const me = await fetch(`${BASE}/api/v1/me`, {
    headers: { authorization: `Bearer ${String(tokens.access_token)}` },
  });
  expect(me.status).toBe(200);
  await page.goto("/");
  await expect(
    page.getByRole("searchbox", { name: "Search the catalog" }),
  ).toBeVisible();
  await expect(page.getByText(/metrics in \d+ datasets?/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Finish setup/ })).toHaveCount(
    0,
  );
});

/** The grant an Allow made, listed on /settings/connections and revoked there. */
async function revokeOnConnections(page: Page, name: string) {
  await page.unrouteAll();
  await page.goto("/settings/connections");
  await page.getByRole("tab", { name: "Agents and the CLI" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: `Revoke ${name}` }).click();
  await expect(row).toHaveCount(0);
  const grants = (await (
    await page.request.get("/api/v1/me/grants")
  ).json()) as {
    grants: { client_name: string | null }[];
  };
  expect(grants.grants.map((g) => g.client_name)).not.toContain(name);
}

test("Power BI is disconnected, then connected again", async ({
  browser,
  page,
}, testInfo) => {
  const email = OWN_PERSON[testInfo.project.name];
  if (email === undefined)
    throw new Error(`No person for project ${testInfo.project.name}`);
  // People get in only with a role; no specs rely on these people having none.
  const admin = await contextAs(browser, "admin");
  await grantRole(admin.request, email, "viewer");
  await admin.close();
  // Signing in with Microsoft connects Power BI on the way.
  await signInWithMicrosoft(
    page,
    email,
    "/sign-in?next=%2Fsettings%2Fconnections",
    "/settings/connections",
  );
  const status = page.getByTestId("powerbi-status");
  await expect(status).toHaveText("Connected");
  await expect(page.getByText(email, { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(status).toHaveText("Not connected");

  await asMicrosoft(email, async () => {
    // The page starts and ends on /settings/connections: wait for Microsoft's answer to arrive.
    const back = page.waitForResponse((response) =>
      response.url().startsWith(`${BASE}/api/v1/powerbi/callback`),
    );
    await page.getByRole("link", { name: "Connect Power BI" }).click();
    expect((await back).status()).toBe(302);
  });
  await expect(page).toHaveURL(onApi("/settings/connections"));
  await expect(status).toHaveText("Connected");
});
