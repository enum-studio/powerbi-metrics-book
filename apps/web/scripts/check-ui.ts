// Screenshots every route in src/router.tsx at 390 and 1440 px, light and dark,
// as the sample admin and signed out, on the dev stack (pnpm dev:up), into
// test-results/check-ui/. Fails on a console error, a sideways scroll, or a
// signed-in page deeper than a lane's top with no breadcrumb or one that wraps.
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type ConsoleMessage } from "@playwright/test";
import { SCHEMES, SIZES } from "../playwright.config.ts";
import { devStackUrl, PEOPLE, signInAs } from "../e2e/fixtures.ts";
import { sampleRoutes } from "../e2e/routes.ts";

const OUT = fileURLToPath(
  new URL("../test-results/check-ui/", import.meta.url),
);

/**
 * States of a screen that only an api call can open, shot for the admin
 * beside the plain path: each gives the address to visit for the state.
 */
const SEEDED: Record<string, Record<string, () => Promise<string>>> = {
  // A live authorization by an MCP client the script registers, as a client does.
  "/oauth/consent": { request: authorizationRequest },
};

/**
 * The signed-in pages below a lane's top: a settings page, or anything in the
 * catalog but the rows at the first lane's root (Metrics' home, Terms, Search).
 */
const DEEP = /^\/(admin\/.|settings\/.|catalog\/(?!(terms|search)$).)/;

const SAMPLE_REDIRECT = "https://client.sample.example/callback";

const register = () =>
  fetch(`${devStackUrl()}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [SAMPLE_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });

/**
 * The sample client's id. The api lets an address register 10 clients a
 * minute, and an e2e run just before may have used them: a 429 is waited out
 * once, for the seconds Better Auth names in X-Retry-After (at most its
 * 60-second window).
 */
async function registerSampleClient(): Promise<string> {
  let registered = await register();
  const seconds = Number(registered.headers.get("x-retry-after"));
  if (
    registered.status === 429 &&
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= 60
  ) {
    console.log(
      `Registering the sample client answered 429: waiting ${String(seconds)} s, as X-Retry-After says, then trying once more.`,
    );
    await sleep(seconds * 1000);
    registered = await register();
  }
  if (registered.status !== 201)
    throw new Error(
      `Registering the sample client answered ${String(registered.status)}: ${await registered.text()}`,
    );
  const { client_id } = (await registered.json()) as { client_id: string };
  return client_id;
}

/** Registered on the first consent shot and reused by the rest. */
let sampleClient: Promise<string> | undefined;

async function authorizationRequest(): Promise<string> {
  sampleClient ??= registerSampleClient();
  const client_id = await sampleClient;
  return `/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: SAMPLE_REDIRECT,
    scope: "mcp offline_access",
    state: "check-ui",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${devStackUrl()}/api/mcp`,
  }).toString()}`;
}

/**
 * What the api refuses a signed-out browser by design, and Chrome logs as an
 * error: who is signed in (401, on every screen), and the setup's state
 * without a setup session (404, on /setup alone).
 */
const SIGNED_OUT_REFUSALS = [
  { api: "/api/v1/me", status: 401, screen: null },
  { api: "/api/setup", status: 404, screen: "/setup" },
] as const;

function expectedRefusal(screen: string, message: ConsoleMessage): boolean {
  const url = message.location().url;
  if (url === "") return false;
  const api = new URL(url).pathname;
  return SIGNED_OUT_REFUSALS.some(
    (refusal) =>
      refusal.api === api &&
      (refusal.screen === null || refusal.screen === screen) &&
      message.text().includes(`status of ${String(refusal.status)} `),
  );
}

const baseURL = devStackUrl();
const paths = await sampleRoutes();
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const failures: string[] = [];

// The admin signs in once, and each admin shot starts from that session: the
// api counts dev sign-ins per address, and an e2e run just before used many.
const signedIn = await browser.newContext({ baseURL });
await signInAs(await signedIn.newPage(), PEOPLE.admin);
const admin = await signedIn.storageState();
await signedIn.close();

for (const path of paths)
  for (const who of ["admin", "signed-out"] as const)
    for (const viewport of SIZES)
      for (const colorScheme of SCHEMES)
        for (const [state, address] of [
          ["", () => Promise.resolve(path)] as const,
          ...(who === "admin" ? Object.entries(SEEDED[path] ?? {}) : []),
        ]) {
          const name = `${path === "/" ? "root" : path.slice(1).replaceAll("/", "_")}${state === "" ? "" : `_${state}`}-${who}-${String(viewport.width)}-${colorScheme}`;
          const context = await browser.newContext({
            baseURL,
            viewport,
            colorScheme,
            ...(who === "admin" ? { storageState: admin } : {}),
          });
          const page = await context.newPage();
          page.on("console", (message) => {
            const expected =
              who === "signed-out" && expectedRefusal(path, message);
            if (message.type() === "error" && !expected)
              failures.push(`${name}: ${message.text()}`);
          });
          page.on("pageerror", (error) =>
            failures.push(`${name}: ${error.message}`),
          );
          await page.goto(await address());
          await page.waitForLoadState("networkidle");
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          if (overflow > 0)
            failures.push(`${name}: scrolls sideways by ${String(overflow)}px`);
          if (who === "admin" && DEEP.test(path)) {
            const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
            if ((await crumb.count()) === 0)
              failures.push(`${name}: has no breadcrumb`);
            else {
              // The trail's first part from 640px, and on a phone the one link back, which a trail with no link above the page leaves out.
              const parts = crumb.locator("li:visible, p:visible > a");
              if ((await parts.count()) > 0) {
                const box = await crumb.boundingBox();
                const part = await parts.first().boundingBox();
                if ((box?.height ?? 0) > (part?.height ?? 0) + 1)
                  failures.push(`${name}: its breadcrumb wraps`);
              }
            }
          }
          await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
          console.log(`${OUT}${name}.png`);
          await context.close();
        }

await browser.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
