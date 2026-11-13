import { Hono, type Context, type Next } from "hono";
import type { MockState } from "../entra/context.js";
import { adminRoutes } from "./admin.js";
import { authenticate, refuseNonAdmin } from "./caller.js";
import { createRuntime } from "./limits.js";
import { queryRoutes } from "./query.js";
import { scannerRoutes } from "./scanner.js";

/**
 * Power BI's REST API, mounted at /powerbi: `{origin}/powerbi/v1.0/myorg/...`
 * is `powerbi.api_url + /v1.0/myorg/...`. Scan results and call counts live
 * in the routes, and a state reset forgets them with the rest.
 */
export function powerBiRoutes(state: MockState): Hono {
  const app = new Hono();
  const runtime = createRuntime();
  const reset = state.reset.bind(state);
  state.reset = () => {
    reset();
    runtime.clear();
  };

  app.use("/v1.0/myorg/admin/*", async (c: Context, next: Next) => {
    const caller = await authenticate(state, c);
    if (caller instanceof Response) return caller;
    const refusal = refuseNonAdmin(state, c, caller);
    if (refusal) return refusal;
    await next();
  });
  app.route("/v1.0/myorg/admin", scannerRoutes(state, runtime));
  app.route("/v1.0/myorg/admin", adminRoutes(state, runtime));
  app.route("/", queryRoutes(state, runtime));
  return app;
}
