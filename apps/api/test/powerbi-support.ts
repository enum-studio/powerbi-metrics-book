import { createHash, randomBytes } from "node:crypto";
import {
  SAMPLE_PUBLIC_BASE_URL,
  startMockPowerBi,
  type MockPowerBiHandle,
  type Person,
  type Tenant,
} from "@powerbi-metrics-book/powerbi-mock";
import { request } from "undici";
import { createGuardedFetcher } from "../src/http/fetcher.js";
import {
  authorizationUrl,
  CONNECTION_SCOPES,
  redeemCode,
  type PowerBiDeps,
  type RedeemedCode,
} from "../src/powerbi/identity.js";
import { MemorySecrets, MemorySettings } from "./doubles.js";

/*
 * The Power BI clients' tests: the mock serving a tenant, and deps whose
 * guarded fetcher, settings and secrets point at it.
 */

export const REDIRECT_URI = `${SAMPLE_PUBLIC_BASE_URL}/api/v1/powerbi/callback`;

export type PowerBiFixture = { mock: MockPowerBiHandle; deps: PowerBiDeps };

/** The one item the test names, or a failure saying the tenant lacks it. */
export function find<T>(items: T[], found: (item: T) => boolean): T {
  const item = items.find(found);
  if (item === undefined) throw new Error("not in the sample tenant");
  return item;
}

export function samplePerson(tenant: Tenant, mailbox: string): Person {
  return find(tenant.people, (p) => p.email === `${mailbox}@sample.example`);
}

export async function startPowerBi(
  tenant: Tenant,
  clock: () => Date = () => new Date(),
): Promise<PowerBiFixture> {
  const mock = await startMockPowerBi({ tenant });
  const principals = tenant.service_principals;
  const scanner = find(principals, (sp) => sp.may_call_admin_apis);
  const app = find(principals, (sp) => !sp.may_call_admin_apis);
  const deps: PowerBiDeps = {
    fetcher: createGuardedFetcher({
      allowedOrigins: () => Promise.resolve([mock.url]),
      nodeEnv: "test",
    }),
    settings: new MemorySettings({
      "powerbi.tenant_id": tenant.tenant_id,
      "powerbi.app_client_id": app.app_id,
      "powerbi.scanner_client_id": scanner.app_id,
      "powerbi.authority": mock.url,
      "powerbi.api_url": `${mock.url}/powerbi`,
      "powerbi.graph_url": `${mock.url}/graph`,
    }),
    secrets: new MemorySecrets([
      ["powerbi_app_client_secret", app.secret],
      ["powerbi_scanner_client_secret", scanner.secret],
    ]),
    clock,
  };
  return { mock, deps };
}

/** Authorize as the person, as their browser would, then the callback's redeem. */
export async function connect(
  { mock, deps }: PowerBiFixture,
  person: Person,
): Promise<RedeemedCode> {
  mock.setActingUser(person.object_id);
  const verifier = randomBytes(32).toString("base64url");
  const url = await authorizationUrl(deps, {
    state: "state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    login_hint: person.email,
    scopes: CONNECTION_SCOPES,
    redirect_uri: REDIRECT_URI,
  });
  const answer = await request(url);
  await answer.body.dump();
  const code = new URL(String(answer.headers.location)).searchParams.get(
    "code",
  );
  if (code === null) throw new Error(`authorize gave ${person.email} no code`);
  return redeemCode(deps, {
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
}
