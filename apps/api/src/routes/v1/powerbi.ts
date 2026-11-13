import { type Context, Hono, type MiddlewareHandler } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { ServiceError } from "../../errors.js";
import {
  requirePerson,
  requirePrincipal,
} from "../../services/auth/principal.js";
import { personById } from "../../services/auth/sign-in.js";
import {
  type BrowserPerson,
  finishConnection,
  startConnection,
} from "../../services/connection/connect.js";
import { disconnect } from "../../services/connection/disconnect.js";
import { credential, failures, refuse, removed } from "./adapter.js";

/** A browser is sent on to Microsoft, or back to the page the connection began from. */
const redirect = (summary: string) =>
  describeRoute({
    summary,
    responses: {
      302: {
        description: summary,
        headers: { Location: { schema: { type: "string" } } },
      },
      ...failures([400, 502]),
    },
  });
// A return path of this app, and what Microsoft sends back: a state and a code.
const Next = z.object({ next: z.string().max(500).optional() });
const Callback = z.object({
  state: z.string().max(500).optional(),
  code: z.string().max(8192).optional(),
});

/**
 * A person's Power BI connection: GET /api/v1/powerbi/connect and its
 * callback, both from a browser session, and DELETE
 * /api/v1/powerbi/connection.
 */
export function powerbiRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  // The state is bound to the session, so the round trip needs one.
  const inSession = (c: Context<AppEnv>) => {
    const principal = requirePrincipal(c);
    const session = c.get("person");
    if (session === undefined)
      throw new ServiceError(
        "refused",
        "Connect Power BI from the browser, signed in to this app.",
      );
    return { principal, session };
  };
  /** The credential of the two redirects, ahead of their validators: a token gets 403, not 400. */
  const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
    inSession(c);
    await next();
  };
  const browser = async (c: Context<AppEnv>) => {
    const { principal, session } = inSession(c);
    const user = await personById(deps.db, principal.id);
    const person: BrowserPerson = {
      user_id: user.id,
      email: user.email,
      email_verified: user.email_verified,
      session_id: session.session_id,
    };
    return { principal, person };
  };

  routes.get(
    "/powerbi/connect",
    redirect("Start the Power BI connection: on to Microsoft's sign-in"),
    sessionOnly,
    validator("query", Next, refuse),
    async (c) => {
      const { person } = await browser(c);
      return c.redirect(
        await startConnection(deps, person, c.req.valid("query").next),
        302,
      );
    },
  );

  routes.get(
    "/powerbi/callback",
    redirect("Finish the Power BI connection: back to the page it began from"),
    sessionOnly,
    validator("query", Callback, refuse),
    async (c) => {
      const { principal, person } = await browser(c);
      const { state, code } = c.req.valid("query");
      const next = await finishConnection({ ...deps, principal }, person, {
        state,
        code,
      });
      return c.redirect(next, 302);
    },
  );

  const end = removed("Disconnect the caller's Power BI connection");
  routes.delete("/powerbi/connection", end.doc, credential, async (c) => {
    await disconnect({ ...deps, principal: requirePerson(c) });
    return end.answer(c);
  });

  return routes;
}
