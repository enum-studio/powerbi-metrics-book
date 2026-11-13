import { sql } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { AppDeps } from "../../context.js";
import { devSignInOpen } from "../auth/dev-sign-in.js";
import { onTheMock } from "../auth/sign-in-config.js";
import { boundTenant } from "./bound.js";

/**
 * The dev sign-in runs only on the mock, bound database or not: open over
 * Microsoft identity it would sign anyone in as any email, over the real
 * tenant's people. The sentence that says so when it is open and the
 * authority is not the mock's; null otherwise.
 */
export function devSignInOffTheMock(
  config: Config,
  authority: string,
): string | null {
  if (!devSignInOpen(config) || onTheMock(authority)) return null;
  return `The dev sign-in is open (NODE_ENV=${config.node_env} with ALLOW_DEV_SIGN_IN=1), and the stack points at Microsoft identity at ${new URL(authority).host}. The dev sign-in runs only on the mock: shut it, or point the stack at the mock.`;
}

/**
 * Throws an Error with one sentence when the row and the config disagree:
 * the stack points at the other side of the mock, or at another tenant, or
 * the dev sign-in is open off the mock. Resolves when they agree. The same
 * refusal as refuseDevSignInResidue: the api and the worker call it at
 * start, and both call it before each job, so a process started before the
 * setup bound the tenant cannot work on the other side. With no row, the api
 * and worker both refuse when an admin exists (a database that predates the
 * binding, or a setup that did not finish). The worker asks a security
 * definer for that one bit and still cannot read roles.
 */
export async function refuseAnotherTenant(
  deps: Pick<AppDeps, "db" | "settings" | "config">,
): Promise<void> {
  const authority = await deps.settings.get("powerbi.authority");
  const dev = devSignInOffTheMock(deps.config, authority);
  if (dev !== null) throw new Error(dev);
  const bound = await boundTenant(deps.db);
  if (bound === null) {
    const result = await deps.db.execute<{ has_admin: boolean }>(
      sql`select deployment_has_admin() as has_admin`,
    );
    if (result.rows[0]?.has_admin === true)
      throw new Error(
        "An admin exists but this database holds no tenant. It was set up before tenants were recorded, or a setup did not finish: start on a new database.",
      );
    return;
  }
  const tenant_id = await deps.settings.get("powerbi.tenant_id");
  const host = new URL(authority).host;
  const docs = new URL(
    "/docs/start/sample-tenant/",
    deps.config.public_base_url,
  );
  const mock = onTheMock(authority);
  if (bound.sample && !mock)
    throw new Error(
      `This database belongs to the sample tenant, and the stack now points at Microsoft identity at ${host}. A database keeps one tenant: start your own tenant on a new database. How: ${docs.href}#move-to-your-own-tenant`,
    );
  if (!bound.sample && mock)
    throw new Error(
      `This database belongs to tenant ${bound.tenant_id}, and the stack now points at the mock at ${host}. The mock never runs over a real tenant's data: run the sample on its own database, which compose.mock.yml gives it. How: ${docs.href}`,
    );
  if (tenant_id?.toLowerCase() !== bound.tenant_id)
    throw new Error(
      `This database belongs to tenant ${bound.tenant_id}, and powerbi.tenant_id is now ${tenant_id ?? "not set"}. A database keeps one tenant: start ${tenant_id ?? "another tenant"} on a new database.`,
    );
}
