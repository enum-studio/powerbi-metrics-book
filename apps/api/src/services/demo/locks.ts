import type { AppDeps } from "../../context.js";
import { onTheMock } from "../auth/sign-in-config.js";
import { boundTenant } from "../setup/bound.js";

/**
 * Throws an Error with one sentence naming the lock that failed when demo
 * mode is on off the sample tenant: the api cannot name a visitor's address,
 * the authority is not the mock, the database belongs to another tenant, or
 * usage capture is on. Resolves with demo mode off. Called beside
 * refuseAnotherTenant: by the api and the worker at start, and before each
 * job. DEMO_MODE with ALLOW_DEV_SIGN_IN is the fifth lock, in loadConfig.
 */
export async function refuseDemoOffTheSample(
  deps: Pick<AppDeps, "db" | "settings" | "config">,
): Promise<void> {
  if (!deps.config.demo_mode) return;
  // The worker has no visitors. In the api, a connection's own address is
  // the proxy's, so without a way to name the client every visitor would
  // share one limit and one search allowance.
  const { config } = deps;
  if (
    config.container === "api" &&
    config.trusted_proxy === null &&
    config.client_address_header !== "x-real-ip"
  )
    throw new Error(
      "Demo mode limits each visitor by address, and without TRUSTED_PROXY every visitor is the proxy: set TRUSTED_PROXY as deploy/demo/README.md step 3 says.",
    );
  const authority = await deps.settings.get("powerbi.authority");
  if (!onTheMock(authority))
    throw new Error(
      `Demo mode runs only on the mock, and powerbi.authority points at ${new URL(authority).host}.`,
    );
  const bound = await boundTenant(deps.db);
  if (bound !== null && !bound.sample)
    throw new Error(
      "Demo mode runs only on the sample tenant's database, and this database belongs to another tenant.",
    );
  if (await deps.settings.get("usage.capture"))
    throw new Error(
      "Demo mode writes nothing per visitor, and usage.capture is on: set it to false.",
    );
}
