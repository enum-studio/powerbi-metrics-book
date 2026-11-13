import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import { CONNECTION_STATUSES } from "../../db/schema/connection.js";
import { peerOf } from "../../http/peer.js";
import { mayAdmin } from "../../services/admin/guard.js";
import { expiringSecrets } from "../../services/admin/status.js";
import { apiConfig } from "../../services/auth/better-auth.js";
import { clientAddress } from "../../services/auth/client-address.js";
import { onTheMock } from "../../services/auth/sign-in-config.js";
import {
  requirePerson,
  requirePrincipal,
} from "../../services/auth/principal.js";
import {
  connectionDetails,
  connectionsPage,
  connectionState,
} from "../../services/connection/store.js";
import { credential, documented } from "./adapter.js";

const Me = z
  .object({
    id: z.string(),
    kind: z.enum(["person", "service_account"]),
    email: z.string().nullable(),
    name: z.string().nullable(),
    roles: z.array(z.string()),
    sign_in_method: z.string().nullable(),
    via: z.enum(["browser", "mcp", "api", "cli"]),
    powerbi_connection: z
      .enum([...CONNECTION_STATUSES, "not_connected"])
      .nullable(),
    powerbi_connect_url: z.string(),
    sample_data: z.boolean(),
    usage: z.object({
      capture: z.boolean(),
      retention_days: z.number().int(),
    }),
    may_admin: z
      .boolean()
      .describe(
        "Whether the admin section opens for the caller: the admin status page's own guard (admin:read_status).",
      ),
    warnings: z.array(z.string()),
    client_address: z
      .string()
      .nullable()
      .describe(
        "The address this request counted against for rate limits and audit, the caller's own. Null for a request made in process.",
      ),
  })
  .meta({ id: "Me" });

const PowerBiConnection = z
  .object({
    status: z.enum([...CONNECTION_STATUSES, "not_connected"]),
    account: z.string().nullable(),
    connected_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: "PowerBiConnection" });

/**
 * GET /api/v1/me: who is calling, their roles now, how they signed in, their
 * Power BI connection, whether this is the sample tenant on the mock (the
 * SPA's "Sample data" band), whether the admin section opens for them (the
 * header's link) and, for whoever manages secrets, a warning for
 * each secret that expires within 30 days, and the client address the api
 * settled on, which is how an operator checks CLIENT_ADDRESS_HEADER. GET /api/v1/me/connection: a
 * person's Power BI connection in full, for their connections page.
 */
export function meRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const me = documented(
    "Who is calling, their roles and their Power BI connection",
    Me,
  );
  routes.get("/me", me.doc, credential, async (c) => {
    const principal = requirePrincipal(c);
    const identity = c.get("identity");
    return me.answer(c, {
      id: principal.id,
      kind: principal.kind,
      email: identity?.email ?? null,
      name: identity?.name ?? null,
      roles: principal.roles,
      // The demo's one person has no session (services/auth/principal.ts).
      sign_in_method:
        c.get("person")?.sign_in_method ??
        (deps.config.demo_mode ? "demo" : null),
      via: principal.via,
      // A service account queries as the app's service principal, never through a connection.
      powerbi_connection:
        principal.kind === "person"
          ? await connectionState(deps.db, principal.id)
          : null,
      // The page, not the round trip: it opens before a person signs in.
      powerbi_connect_url: connectionsPage(deps.config),
      usage: {
        capture: await deps.settings.get("usage.capture"),
        retention_days: await deps.settings.get("usage.retention_days"),
      },
      sample_data: onTheMock(await deps.settings.get("powerbi.authority")),
      may_admin: await mayAdmin({ ...deps, principal }, "read_status"),
      warnings: (await mayAdmin({ ...deps, principal }, "manage_secrets"))
        ? (await expiringSecrets(deps.db, deps.clock())).map((s) => s.warning)
        : [],
      client_address: clientAddress(
        peerOf(c.env),
        c.req.raw.headers,
        apiConfig(deps.config),
      ),
    });
  });
  const connection = documented(
    "The caller's Power BI connection: the account, when it was last used, and why it needs a reconnect",
    PowerBiConnection,
  );
  routes.get("/me/connection", connection.doc, credential, async (c) =>
    connection.answer(c, await connectionDetails(deps.db, requirePerson(c).id)),
  );
  return routes;
}
