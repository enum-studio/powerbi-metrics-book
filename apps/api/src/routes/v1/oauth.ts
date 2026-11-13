import { type Context, Hono, type MiddlewareHandler } from "hono";
import { validator } from "hono-openapi";
import * as z from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { ServiceError } from "../../errors.js";
import { peerOf } from "../../http/peer.js";
import type { Auth } from "../../services/auth/better-auth.js";
import { answerDevice, deviceRequest } from "../../services/auth/device.js";
import { answerConsent, consentRequest } from "../../services/auth/oauth.js";
import { requirePrincipal } from "../../services/auth/principal.js";
import { documented, refuse, removed } from "./adapter.js";

// The signed query Better Auth sent the browser to the consent screen with, whole.
const CONSENT_ANSWER = z.object({
  request: z.string().min(1).max(8192),
  allow: z.boolean(),
});
const DEVICE_ANSWER = z.object({
  user_code: z.string().min(1).max(500),
  allow: z.boolean(),
});
const DEVICE_LOOKUP = z.object({ user_code: z.string().max(500).optional() });

const Person = z.object({ email: z.string(), name: z.string() });
const Will = {
  will: z.array(z.string()),
  will_not: z.array(z.string()),
};
const ConsentRequest = z
  .object({
    person: Person,
    client: z.object({
      id: z.string(),
      vouched_host: z.string().nullable(),
      claimed_name: z.string().nullable(),
      registered_at: z.string().nullable(),
      // metadata_document, this_api or dynamic_registration.
      registered_by: z.string(),
    }),
    redirect: z
      .object({
        scheme: z.string(),
        host: z.string().nullable(),
        private_use: z.boolean(),
      })
      .nullable(),
    scopes: z.array(z.string()),
    ...Will,
  })
  .meta({ id: "ConsentRequest" });
const DeviceRequest = z
  .object({
    person: Person,
    user_code: z.string(),
    client_id: z.string(),
    client_name: z.string(),
    started_at: z.string(),
    started_from: z.string().nullable(),
    ...Will,
  })
  .meta({ id: "DeviceRequest" });

/**
 * A grant is answered only in a browser, signed in to this site: never with
 * a token an MCP client or the CLI holds.
 */
function inBrowser(c: Context<AppEnv>) {
  const principal = requirePrincipal(c);
  const person = c.get("person");
  if (principal.via !== "browser" || person === undefined)
    throw new ServiceError(
      "refused",
      "Answer this in your browser, signed in to this site.",
    );
  return {
    principal,
    person: { email: person.email, name: person.name },
    caller: { headers: c.req.raw.headers, peer: peerOf(c.env) },
  };
}

/** The credential of these routes, ahead of their validators: a browser session, nothing else. */
const browserOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  inBrowser(c);
  await next();
};

/**
 * The consent screen and the CLI's device code page, as APIs the SPA
 * renders. The signed consent request and the user code travel in the
 * query string or the body, never the path, so the request log, which
 * names only the path, never holds them.
 *
 * - GET /oauth/consent?<the query Better Auth sent the browser to /oauth/consent with>
 * - POST /oauth/consent { request: <that query>, allow }
 * - GET /oauth/device?user_code=<what the person typed>
 * - POST /oauth/device { user_code, allow }
 */
export function oauthRoutes(deps: AppDeps, auth: Auth): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const consent = documented(
    "What an MCP client asks to be allowed, from the signed query Better Auth sent",
    ConsentRequest,
    { errors: [404] },
  );
  routes.get("/oauth/consent", consent.doc, browserOnly, async (c) => {
    const { person } = inBrowser(c);
    const query = new URL(c.req.url).search.slice(1);
    return consent.answer(c, {
      person,
      ...(await consentRequest(deps, query)),
    });
  });
  const answered = documented(
    "Allow or deny an MCP client; answers where the browser goes next",
    z.object({ redirect_to: z.string() }),
    { errors: [400, 404] },
  );
  routes.post(
    "/oauth/consent",
    answered.doc,
    browserOnly,
    validator("json", CONSENT_ANSWER, refuse),
    async (c) => {
      const { caller } = inBrowser(c);
      const { request, allow } = c.req.valid("json");
      return answered.answer(c, {
        redirect_to: await answerConsent(deps, auth, caller, request, allow),
      });
    },
  );
  const device = documented(
    "What the CLI asks to be allowed, for the code a person typed",
    DeviceRequest,
    { errors: [404] },
  );
  routes.get(
    "/oauth/device",
    device.doc,
    browserOnly,
    validator("query", DEVICE_LOOKUP, refuse),
    async (c) => {
      const { principal, person, caller } = inBrowser(c);
      const user_code = c.req.valid("query").user_code ?? "";
      return device.answer(c, {
        person,
        ...(await deviceRequest(deps, auth, caller, principal, user_code)),
      });
    },
  );
  const deviceAnswer = removed(
    "Allow or deny the CLI's device code",
    [400, 404],
  );
  routes.post(
    "/oauth/device",
    deviceAnswer.doc,
    browserOnly,
    validator("json", DEVICE_ANSWER, refuse),
    async (c) => {
      const { principal, caller } = inBrowser(c);
      const { user_code, allow } = c.req.valid("json");
      await answerDevice(deps, auth, caller, principal, user_code, allow);
      return deviceAnswer.answer(c);
    },
  );
  return routes;
}
