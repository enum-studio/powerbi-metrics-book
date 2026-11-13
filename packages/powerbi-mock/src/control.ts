import { Hono, type Context } from "hono";
import {
  isRecord,
  readJsonObject,
  setActingUser,
  type MockState,
} from "./entra/context.js";
import type { Outbox } from "./resend.js";
import { defaultTenantSettings, type TenantSettings } from "./tenant.js";

function refuse(c: Context, status: 400 | 404, message: string): Response {
  return c.json({ error: message }, status);
}

function isSettingKey(key: string): key is keyof TenantSettings {
  return Object.hasOwn(defaultTenantSettings(), key);
}

/**
 * What startMockPowerBi's handle does in process, for a test that drives the
 * mock in its container (Playwright, the end-to-end test). Mount at /_mock,
 * and only when the options ask for it: it changes the tenant without a token.
 */
export function controlRoutes(state: MockState, outbox: Outbox): Hono {
  const app = new Hono();
  app.get("/outbox", (c) => c.json(outbox));

  app.patch("/people/:object_id", async (c) => {
    const body = await readJsonObject(c);
    if (
      typeof body?.guest !== "boolean" ||
      (body.guest && typeof body.home_address !== "string")
    )
      return refuse(
        c,
        400,
        "guest must be boolean; a guest needs home_address.",
      );
    const person = state.tenant.people.find(
      (person) => person.object_id === c.req.param("object_id"),
    );
    if (!person) return refuse(c, 404, "No such person in the tenant.");
    person.guest = body.guest;
    if (typeof body.home_address === "string")
      person.home_address = body.home_address;
    return c.body(null, 204);
  });

  app.patch("/apps/:client_id", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body?.email_optional_claim !== "boolean")
      return refuse(c, 400, "email_optional_claim must be boolean.");
    const registration = state.tenant.apps_registrations.find(
      (app) => app.client_id === c.req.param("client_id"),
    );
    if (!registration)
      return refuse(c, 404, "No such app registration in the tenant.");
    registration.email_optional_claim = body.email_optional_claim;
    return c.body(null, 204);
  });

  app.post("/acting-user", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body?.object_id !== "string")
      return refuse(c, 400, "object_id is required.");
    if (!setActingUser(state, body.object_id))
      return refuse(c, 404, `No person ${body.object_id} in the tenant.`);
    return c.body(null, 204);
  });

  app.patch("/settings", async (c) => {
    const body = await readJsonObject(c);
    if (!body) return refuse(c, 400, "A JSON object is required.");
    const { service_principal, ...settings } = body;

    const changes: Partial<TenantSettings> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (!isSettingKey(key) || typeof value !== "boolean") {
        return refuse(
          c,
          400,
          `${key} is not a boolean tenant setting (${Object.keys(defaultTenantSettings()).join(", ")}).`,
        );
      }
      changes[key] = value;
    }
    let principal: { app_id: string; may_call_admin_apis: boolean } | undefined;
    if (service_principal !== undefined) {
      if (
        !isRecord(service_principal) ||
        typeof service_principal.app_id !== "string" ||
        typeof service_principal.may_call_admin_apis !== "boolean"
      ) {
        return refuse(
          c,
          400,
          "service_principal must be { app_id: string, may_call_admin_apis: boolean }.",
        );
      }
      principal = {
        app_id: service_principal.app_id,
        may_call_admin_apis: service_principal.may_call_admin_apis,
      };
    }

    const target =
      principal &&
      state.tenant.service_principals.find(
        (sp) => sp.app_id === principal.app_id,
      );
    if (principal && !target)
      return refuse(
        c,
        404,
        `No service principal ${principal.app_id} in the tenant.`,
      );
    Object.assign(state.tenant.settings, changes);
    if (principal && target)
      target.may_call_admin_apis = principal.may_call_admin_apis;

    return c.json({
      settings: state.tenant.settings,
      service_principals: state.tenant.service_principals.map((sp) => ({
        app_id: sp.app_id,
        may_call_admin_apis: sp.may_call_admin_apis,
      })),
    });
  });

  app.post("/fail-next", async (c) => {
    const body = await readJsonObject(c);
    const { route_prefix, status, retry_after_seconds } = body ?? {};
    if (typeof route_prefix !== "string" || route_prefix === "")
      return refuse(c, 400, "route_prefix is required.");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      return refuse(c, 400, "status must be an HTTP error status, 400 to 599.");
    }
    if (
      retry_after_seconds !== undefined &&
      (typeof retry_after_seconds !== "number" || retry_after_seconds < 0)
    ) {
      return refuse(
        c,
        400,
        "retry_after_seconds must be a number of seconds, 0 or more.",
      );
    }
    state.failures.push({ route_prefix, status, retry_after_seconds });
    return c.body(null, 204);
  });

  app.post("/reset", (c) => {
    state.reset();
    return c.body(null, 204);
  });

  return app;
}
