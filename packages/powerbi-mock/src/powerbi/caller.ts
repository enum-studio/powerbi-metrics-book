import type { Context } from "hono";
import { findPerson, type MockState } from "../entra/context.js";
import { POWER_BI_AUDIENCE, verifyBearer } from "../entra/tokens.js";
import type { Person, ServicePrincipal } from "../tenant.js";
import { powerBiError } from "./wire.js";

export type Caller =
  | { kind: "person"; person: Person; id: string; scopes: string[] }
  | { kind: "service_principal"; principal: ServicePrincipal; id: string };

const NOT_AUTHORIZED = "PowerBINotAuthorizedException";

/** The caller a Power BI token stands for, or the 401 for a token that stands for nobody in the tenant. */
export async function authenticate(
  state: MockState,
  c: Context,
): Promise<Caller | Response> {
  const bearer = await verifyBearer(
    state,
    c.req.header("authorization"),
    POWER_BI_AUDIENCE,
  );
  if ("error" in bearer) {
    return powerBiError(c, 401, NOT_AUTHORIZED, bearer.error);
  }
  const { claims } = bearer;

  if (claims.idtyp === "app") {
    const principal = state.tenant.service_principals.find(
      (candidate) => candidate.app_id === claims.appid,
    );
    if (!principal) {
      return powerBiError(
        c,
        401,
        NOT_AUTHORIZED,
        "The token's service principal is not in the tenant.",
      );
    }
    return { kind: "service_principal", principal, id: principal.object_id };
  }

  const person = findPerson(
    state,
    typeof claims.oid === "string" ? claims.oid : undefined,
  );
  if (!person) {
    return powerBiError(
      c,
      401,
      NOT_AUTHORIZED,
      "The token's user is not in the tenant.",
    );
  }
  const scopes = typeof claims.scp === "string" ? claims.scp.split(" ") : [];
  return { kind: "person", person, id: person.object_id, scopes };
}

/**
 * The admin APIs take a service principal the tenant allows, nobody else.
 * https://learn.microsoft.com/en-us/rest/api/power-bi/admin/workspace-info-post-workspace-info
 */
export function refuseNonAdmin(
  state: MockState,
  c: Context,
  caller: Caller,
): Response | null {
  if (caller.kind === "person") {
    return powerBiError(
      c,
      401,
      NOT_AUTHORIZED,
      "The admin APIs take a service principal's token; a signed-in user's is refused here.",
    );
  }
  if (
    !state.tenant.settings.service_principals_admin_apis ||
    !caller.principal.may_call_admin_apis
  ) {
    return powerBiError(
      c,
      401,
      NOT_AUTHORIZED,
      "API is not accessible for application",
    );
  }
  return null;
}
