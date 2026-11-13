import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { listGrants, revokeGrant } from "../../services/auth/grants.js";
import { requirePerson } from "../../services/auth/principal.js";
import {
  credential,
  documented,
  iso,
  refuse,
  removed,
  text,
} from "./adapter.js";

export const Grant = z
  .object({
    id: z.string(),
    client_id: z.string(),
    client_name: z.string().nullable(),
    via: z.enum(["mcp", "cli"]),
    scopes: z.array(z.string()),
    granted_at: iso,
    last_used_at: iso.nullable(),
  })
  .meta({ id: "Grant" });

/** GET /api/v1/me/grants and DELETE /api/v1/me/grants/:id: the person's MCP and CLI connections. */
export function grantsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const list = documented(
    "The caller's MCP and CLI connections",
    z.object({ grants: z.array(Grant) }),
  );
  routes.get("/me/grants", list.doc, credential, async (c) =>
    list.answer(c, { grants: await listGrants(deps, requirePerson(c)) }),
  );
  const end = removed("End one of the caller's own connections", [404]);
  routes.delete(
    "/me/grants/:id",
    end.doc,
    credential,
    validator("param", z.object({ id: text }), refuse),
    async (c) => {
      await revokeGrant(deps, requirePerson(c), c.req.valid("param").id);
      return end.answer(c);
    },
  );
  return routes;
}
