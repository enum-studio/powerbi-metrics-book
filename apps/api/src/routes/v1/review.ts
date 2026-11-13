import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { approveMetric } from "../../services/book/metrics.js";
import {
  credential,
  documented,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";
import { Metric } from "./schemas.js";

/**
 * POST /api/v1/metrics/:name/approve: a curator's approval. The service
 * decides who may from the conventions: a browser session only, unless
 * trust.human_verify_from says any (approval_browser_only_security_test.ts).
 */
export function reviewRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const approve = documented("Approve a metric (human_verified)", Metric, {
    errors: [400, 404],
  });
  routes.post(
    "/metrics/:name/approve",
    approve.doc,
    credential,
    validator("param", z.object({ name: text }), refuse),
    async (c) =>
      approve.answer(
        c,
        await approveMetric(serviceContext(deps)(c), c.req.valid("param").name),
      ),
  );
  return routes;
}
