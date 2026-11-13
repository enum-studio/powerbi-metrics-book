import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Context } from "hono";
import type { Person, Tenant } from "../tenant.js";

export type SigningKeys = {
  kid: string;
  private_key: KeyObject;
  public_key: KeyObject;
  /** The public half as it appears in a JWKS. */
  jwk: Record<string, unknown>;
};

/** What an authorization code stands for until it is redeemed once. */
export type AuthorizationGrant = {
  provider: "microsoft" | "oidc";
  client_id: string;
  redirect_uri: string;
  scope: string;
  person_oid: string;
  code_challenge: string;
  nonce: string | null;
  spent: boolean;
};

export type RefreshGrant = {
  client_id: string;
  scope: string;
  person_oid: string;
  spent: boolean;
};

export type InjectedFailure = {
  route_prefix: string;
  status: number;
  retry_after_seconds?: number;
};

/** The state every route shares. Routes read `tenant` on each request, never capture it. */
export type MockState = {
  tenant: Tenant;
  /** Fixed by the options; without it each answer names the origin the request came to. */
  origin: string | undefined;
  keys: SigningKeys;
  acting_user: string | null;
  failures: InjectedFailure[];
  codes: Map<string, AuthorizationGrant>;
  refresh_tokens: Map<string, RefreshGrant>;
  /** Puts the tenant back as it was at creation, and forgets every grant, acting person and queued failure. */
  reset(): void;
};

function generateKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = randomUUID();
  return {
    kid,
    private_key: privateKey,
    public_key: publicKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      use: "sig",
      alg: "RS256",
    },
  };
}

export function createState(tenant: Tenant, origin?: string): MockState {
  const initial = structuredClone(tenant);
  const state: MockState = {
    tenant,
    origin,
    keys: generateKeys(),
    acting_user: null,
    failures: [],
    codes: new Map(),
    refresh_tokens: new Map(),
    reset() {
      Object.assign(state.tenant, structuredClone(initial));
      state.acting_user = null;
      state.failures.length = 0;
      state.codes.clear();
      state.refresh_tokens.clear();
    },
  };
  return state;
}

export function originOf(state: MockState, c: Context): string {
  return state.origin ?? new URL(c.req.url).origin;
}

export function findPerson(
  state: MockState,
  object_id: string | null | undefined,
): Person | undefined {
  return state.tenant.people.find((person) => person.object_id === object_id);
}

/** False when the tenant has no such person. */
export function setActingUser(state: MockState, object_id: string): boolean {
  if (!findPerson(state, object_id)) return false;
  state.acting_user = object_id;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body as an object, or null when it is not JSON or not an object. */
export async function readJsonObject(
  c: Context,
): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return isRecord(body) ? body : null;
}
