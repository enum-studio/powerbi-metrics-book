import type { E2eStack } from "./stack.js";

/** What a failing step says: the request, the status and the start of the body. */
export async function answered(
  response: Response,
  status: number,
  what: string,
): Promise<Response> {
  if (response.status !== status)
    throw new Error(
      `${what}: expected ${String(status)}, the answer was ${String(response.status)}: ${(await response.text()).slice(0, 600)}`,
    );
  return response;
}

/** The JSON of an answer that had the status asked. */
export async function json<T>(
  response: Response,
  status: number,
  what: string,
): Promise<T> {
  return (await (await answered(response, status, what)).json()) as T;
}

type Send = { method?: string; json?: unknown; bearer?: string };

/**
 * What a browser keeps between requests to the api: one cookie per name, sent
 * where its path matches, and an Origin on every request that changes state.
 * Secure is ignored, as Chrome and Firefox do on localhost. Redirects are
 * returned, never followed, so each hop can be checked.
 */
export function browser(origin: string) {
  const jar = new Map<string, { value: string; path: string }>();
  return {
    origin,
    /** GET path's JSON, which must answer 200. */
    async get<T>(path: string): Promise<T> {
      return json<T>(await this.send(path), 200, `GET ${path}`);
    },
    async send(target: string, { method = "GET", json: body }: Send = {}) {
      const url = new URL(target, origin);
      const headers: Record<string, string> = {};
      if (url.origin === origin) {
        const cookie = [...jar]
          .filter(([, c]) => url.pathname.startsWith(c.path))
          .map(([name, c]) => `${name}=${c.value}`)
          .join("; ");
        if (cookie !== "") headers.cookie = cookie;
        if (method !== "GET") headers.origin = origin;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      if (url.origin === origin)
        for (const line of response.headers.getSetCookie()) {
          const [, name, value] = /^([^=]+)=([^;]*)/.exec(line) ?? [];
          if (name === undefined || value === undefined) continue;
          const path = /;\s*path=([^;]+)/i.exec(line)?.[1] ?? "/";
          if (value === "") jar.delete(name);
          else jar.set(name, { value, path });
        }
      return response;
    },
  };
}
export type Browser = ReturnType<typeof browser>;

/** A request with a bearer credential, as a script or an agent sends it: no cookie, no Origin. */
export function bearer(
  url: string,
  token: string,
  { method = "GET", json: body }: Send = {},
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

/**
 * The part of a sign-in or a Power BI connection that happens at Microsoft:
 * who authorizes is chosen at the mock's control route, the browser opens the
 * mock's authorize page, and follows its redirect back to the api. A browser
 * resolves *.localhost to loopback; here it is done by hand. The api's
 * answer to its callback.
 */
export async function atMicrosoft(
  web: Browser,
  stack: E2eStack,
  authorizeUrl: string,
  objectId: string,
): Promise<Response> {
  await answered(
    await fetch(`${stack.mock_url}/_mock/acting-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_id: objectId }),
    }),
    204,
    "POST /_mock/acting-user",
  );
  const at = new URL(authorizeUrl);
  if (at.hostname.endsWith(".localhost")) at.hostname = "127.0.0.1";
  const authorized = await fetch(at, { redirect: "manual" });
  const back = authorized.headers.get("location");
  if (authorized.status !== 302 || back === null)
    throw new Error(
      `The mock's authorize did not send the browser back to the api: ${String(authorized.status)}: ${(await authorized.text()).slice(0, 600)}`,
    );
  return web.send(back);
}

/** Sign in with Microsoft as the person, from the api's button to its callback. */
export async function signInWithMicrosoft(
  web: Browser,
  stack: E2eStack,
  objectId: string,
  callbackURL = "/",
): Promise<void> {
  const { url } = await json<{ url: string }>(
    await web.send("/api/auth/sign-in/social", {
      method: "POST",
      json: { provider: "microsoft", callbackURL },
    }),
    200,
    "POST /api/auth/sign-in/social",
  );
  await answered(
    await atMicrosoft(web, stack, url, objectId),
    302,
    "Microsoft's sign-in callback",
  );
}

/** The person's Power BI connection, made through the mock's consent. */
export async function connectPowerBi(
  web: Browser,
  stack: E2eStack,
  objectId: string,
): Promise<void> {
  const started = await answered(
    await web.send("/api/v1/powerbi/connect?next=/"),
    302,
    "GET /api/v1/powerbi/connect",
  );
  const location = started.headers.get("location");
  if (location === null)
    throw new Error("GET /api/v1/powerbi/connect named no Location");
  await answered(
    await atMicrosoft(web, stack, location, objectId),
    302,
    "GET /api/v1/powerbi/callback",
  );
}
