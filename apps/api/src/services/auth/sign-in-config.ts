import type { AppDeps, Db } from "../../context.js";
import { isMockHost } from "../../http/fetcher.js";
import { brandOf } from "../admin/branding.js";
import { hasAdmin } from "../admin/people.js";
import { devSignInOpen } from "./dev-sign-in.js";

export type SignInOption = {
  id: string;
  kind: "microsoft" | "google" | "oidc";
  name: string;
};

/** Only the mock answers as Microsoft identity from a host that is localhost, ends in .localhost, or is exactly 127.0.0.1 or [::1]. */
export function onTheMock(authority: string): boolean {
  return isMockHost(new URL(authority).hostname);
}

type SignInConfig = Awaited<ReturnType<typeof signInConfig>>;

/** As long as Better Auth serves what it read (better-auth.ts, READ_FOR_MS), so the page and sign-in agree. */
const SERVES_FOR_MS = 30_000;
const SETUP = new WeakMap<Db, { finished: boolean; generation: number }>();

function setupState(db: Db) {
  let state = SETUP.get(db);
  if (state === undefined) {
    state = { finished: false, generation: 0 };
    SETUP.set(db, state);
  }
  return state;
}

export function signInSetupFinished(db: Db): void {
  const state = setupState(db);
  state.finished = true;
  signInConfigChanged(db);
}

export function signInConfigChanged(db: Db): void {
  setupState(db).generation += 1;
}

/** Whether a setting is part of what /api/auth/config answers beyond the sign-in options, so saving it must bump the cache. */
export function inSignInConfig(key: string): boolean {
  return key.startsWith("branding.") || key === "access.default_role";
}

/**
 * signInConfig, read at most once every 30 seconds however many requests
 * arrive: the route is public, so nobody without a session can make the api
 * read settings and open secrets on every request. Requests that arrive while
 * a read runs share it.
 */
export function signInConfigReader(deps: AppDeps): () => Promise<SignInConfig> {
  let cached: {
    value: Promise<SignInConfig>;
    until: number;
    generation: number;
  } | null = null;
  return () => {
    const now = deps.clock().getTime();
    const { generation } = setupState(deps.db);
    if (
      cached === null ||
      now >= cached.until ||
      cached.generation !== generation
    ) {
      const value = signInConfig(deps);
      cached = { value, until: now + SERVES_FOR_MS, generation };
      // The caller gets the failure through `value`; it is only not kept, so the next request reads again.
      value.then(undefined, () => {
        if (cached?.value === value) cached = null;
      });
    }
    return cached.value;
  };
}

/**
 * What the sign-in page offers someone not signed in yet: the providers that
 * can sign a person in now, whether passkeys are on, whether the dev
 * sign-in route exists, and whether the stack runs on the mock tenant (the
 * SPA's "Sample data" band, which a signed-out screen carries too). A provider counts once Better Auth is built with it,
 * the same rule as better-auth.ts: Microsoft needs the tenant, the app's
 * client id and its secret; another provider needs its secret. Nothing here
 * names a client id, an issuer or a redirect URI, and a secret is read only
 * to learn whether it is set.
 */
export async function signInConfig(deps: AppDeps): Promise<{
  providers: SignInOption[];
  passkeys: boolean;
  email_password: boolean;
  dev_sign_in: boolean;
  sample_data: boolean;
  setup_pending: boolean;
  brand: Awaited<ReturnType<typeof brandOf>>;
  invite_only: boolean;
}> {
  const { settings, secrets } = deps;
  const [tenant_id, app_client_id, others, passkeys, app_secret, authority] =
    await Promise.all([
      settings.get("powerbi.tenant_id"),
      settings.get("powerbi.app_client_id"),
      settings.get("sign_in.providers"),
      settings.get("sign_in.passkeys"),
      secrets.read("powerbi_app_client_secret"),
      settings.get("powerbi.authority"),
    ]);
  const microsoft: SignInOption[] =
    tenant_id !== null && app_client_id !== null && app_secret !== null
      ? [{ id: "microsoft", kind: "microsoft", name: "Microsoft" }]
      : [];
  const ready = await Promise.all(
    others.map(async (provider) =>
      (await secrets.read(`sign_in_${provider.id}_client_secret`)) === null
        ? []
        : [{ id: provider.id, kind: provider.kind, name: provider.label }],
    ),
  );
  const setup = setupState(deps.db);
  if (!setup.finished) {
    const exists = await hasAdmin(deps.db);
    setup.finished ||= exists;
  }
  return {
    providers: [...microsoft, ...ready.flat()],
    passkeys,
    email_password: await settings.get("sign_in.email_password"),
    dev_sign_in: devSignInOpen(deps.config),
    sample_data: onTheMock(authority),
    setup_pending: !setup.finished,
    brand: await brandOf(deps),
    invite_only: (await settings.get("access.default_role")) === "none",
  };
}
