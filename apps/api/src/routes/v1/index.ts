import { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { adminRoutes } from "./admin.js";
import { conventionsRoutes } from "./conventions.js";
import { curationRoutes } from "./curation.js";
import { eventsRoutes } from "./events.js";
import { grantsRoutes } from "./grants.js";
import { meRoutes } from "./me.js";
import { powerbiRoutes } from "./powerbi.js";
import { queriesRoutes } from "./queries.js";
import { readRoutes } from "./read.js";
import { requestsRoutes } from "./requests.js";
import { reviewRoutes } from "./review.js";
import { usageRoutes } from "./usage.js";
import { threadsRoutes } from "./threads.js";

/**
 * Every REST route module, mounted under /api/v1. A module returns its own
 * Hono with paths relative to /api/v1 (`/metrics`, `/metrics/:id`), and is
 * registered with one line here.
 */
const ROUTE_MODULES: readonly ((deps: AppDeps) => Hono<AppEnv>)[] = [
  meRoutes,
  grantsRoutes,
  powerbiRoutes,
  curationRoutes,
  reviewRoutes,
  conventionsRoutes,
  queriesRoutes,
  threadsRoutes,
  requestsRoutes,
  usageRoutes,
  readRoutes,
  eventsRoutes,
  adminRoutes,
];

export function v1Routes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  // An admin answer names people, grants and settings, so no cache keeps it, whatever the status.
  routes.use("/admin/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  for (const module of ROUTE_MODULES) routes.route("/", module(deps));
  return routes;
}
