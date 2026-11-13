import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { devStackUrl, expect, OBJECT_ID } from "./fixtures.ts";

/*
 * Signs a sample person in the way a browser does on the dev stack, through
 * the mock's Microsoft, and connects their Power BI, as scripts/dev-stack.mjs
 * does for the admin. Unlike the dev sign-in this gives the person the reach
 * the sample's audiences and groups give them (packages/powerbi-mock/src/
 * sample/README.md), so they see the datasets they would in Power BI.
 */

/** The mock sits on the port after the api's (devIdentity in scripts/dev-stack.mjs). */
const mockUrl = () =>
  `http://127.0.0.1:${String(Number(new URL(devStackUrl()).port) + 1)}`;

/**
 * The mock keeps one acting user for everyone, so a parallel worker may
 * change it between the choice and the authorization. Whose session this
 * became is checked afterwards, and the whole sign-in tried again.
 */
const ATTEMPTS = 5;

async function authorizeAt(
  request: APIRequestContext,
  authorizeUrl: string,
  objectId: string,
): Promise<void> {
  const acting = await fetch(`${mockUrl()}/_mock/acting-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ object_id: objectId }),
  });
  if (acting.status !== 204)
    throw new Error(`The mock's acting user answered ${String(acting.status)}`);
  // A browser resolves any *.localhost name to loopback; here it is done by hand.
  const at = new URL(authorizeUrl);
  if (at.hostname.endsWith(".localhost")) at.hostname = "127.0.0.1";
  const authorized = await fetch(at, { redirect: "manual" });
  const back = authorized.headers.get("location");
  if (authorized.status !== 302 || back === null)
    throw new Error(
      `The mock did not send the sign-in back to the api (${String(authorized.status)})`,
    );
  const callback = await request.get(back, { maxRedirects: 0 });
  if (callback.status() !== 302)
    throw new Error(`The api's callback answered ${String(callback.status())}`);
}

const location = (response: {
  headers: () => Record<string, string>;
}): string => {
  const to = response.headers().location;
  if (to === undefined) throw new Error("The api did not redirect");
  return to;
};

async function attempt(request: APIRequestContext, objectId: string) {
  const origin = devStackUrl();
  const start = await request.post("/api/auth/sign-in/social", {
    headers: { origin },
    data: { provider: "microsoft", callbackURL: "/" },
  });
  const { url } = (await start.json()) as { url: string };
  await authorizeAt(request, url, objectId);
  const connect = await request.get("/api/v1/powerbi/connect?next=/", {
    maxRedirects: 0,
  });
  await authorizeAt(request, location(connect), objectId);
}

/**
 * Signs the context in as the person through Microsoft and connects their
 * Power BI; their role comes from the admin first. Fails with the reason when the
 * person is already known to the api through the dev sign-in, which the api
 * will not link to a Microsoft account: pnpm dev:reset starts clean.
 */
export async function signInThroughMicrosoft(
  context: BrowserContext,
  email: string,
): Promise<void> {
  const objectId = OBJECT_ID[email];
  if (objectId === undefined)
    throw new Error(`${email} is not a sample person this helper signs in`);

  for (let tries = 1; tries <= ATTEMPTS; tries++) {
    await context.clearCookies();
    await attempt(context.request, objectId);
    const me = (await (await context.request.get("/api/v1/me")).json()) as {
      email?: string;
      powerbi_connection?: string;
    };
    if (me.email === email && me.powerbi_connection === "connected") return;
  }
  throw new Error(
    `Signing in ${email} through Microsoft did not give a connected session in ${String(ATTEMPTS)} tries. If a dev sign-in made this person earlier, pnpm dev:reset starts clean.`,
  );
}

/**
 * Clicks Continue with Microsoft on the page as the person, and waits until
 * the browser is back on the api at landing. The mock's acting user is one
 * for everyone, so only a @tenant test, which runs alone, calls this;
 * access.spec.ts holds a lock for the projects that run at once.
 */
export async function continueWithMicrosoft(
  page: Page,
  objectId: string,
  landing: string,
): Promise<void> {
  const acting = await fetch(`${mockUrl()}/_mock/acting-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ object_id: objectId }),
  });
  expect(acting.status, "the mock's acting user").toBe(204);
  await page.getByRole("button", { name: "Continue with Microsoft" }).click();
  await expect(page).toHaveURL(
    (url) => url.origin === devStackUrl() && url.pathname === landing,
    { timeout: 20_000 },
  );
}

/** The mail the mock's Resend took for one address, oldest first, each with the first link in its text. */
export async function mailTo(
  email: string,
): Promise<{ subject: string; text: string; link: string | undefined }[]> {
  const outbox = await fetch(`${mockUrl()}/_mock/outbox`);
  expect(outbox.status, "the mock's outbox").toBe(200);
  const mail = (await outbox.json()) as {
    to: string;
    subject: string;
    text: string;
  }[];
  return mail
    .filter((each) => each.to === email)
    .map(({ subject, text }) => ({
      subject,
      text,
      link: /https?:\/\/\S+/.exec(text)?.[0],
    }));
}
