import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Person } from "@powerbi-metrics-book/powerbi-mock";
import { eq, sql } from "drizzle-orm";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import {
  cookies,
  OIDC,
  type SignInFixture,
  startSignIn,
  UNVERIFIED_OIDC,
} from "../../../test/sign-in-support.js";
import { softwarePasskey } from "../../../test/passkey-support.js";
import { account, session, user } from "../../db/schema/auth.js";
import { personSignIn } from "../../db/schema/roles.js";
import { assignRole, MICROSOFT, NOT_ASSIGNED, revokeRole } from "./roles.js";
import {
  admitSession,
  claimsOf,
  microsoftClaims,
  PASSKEY_STALE,
} from "./sign-in.js";

/*
 * The sign-in rules that keep the wrong person out: whose email counts,
 * whose groups count, which tokens are taken, which Better Auth paths are
 * open, how long a session and a passkey last, and what Better Auth logs.
 */

let f: SignInFixture;

beforeAll(async () => {
  f = await startSignIn({ env: { ALLOW_DEV_SIGN_IN: "1" } });
  // These sign-ins reach their people through the default role.
  await f.settings.set("access.default_role", "viewer");
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

const json = {
  "content-type": "application/json",
  origin: TEST_PUBLIC_BASE_URL,
};

function errorOf(callback: Response): string | null {
  expect(callback.status).toBe(302);
  const location = String(callback.headers.get("location"));
  return new URL(location, TEST_PUBLIC_BASE_URL).searchParams.get("error");
}

async function devSignIn(email: string): Promise<string> {
  const response = await f.request("/api/auth/dev/sign-in", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(200);
  return cookies(response);
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await f.deps.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (row === undefined) throw new Error(`nobody signed in as ${email}`);
  return row.id;
}

const assigned = new Map<string, Promise<{ id: string }>>();

/** Assigns viewer to the person by email, once. */
function assign(who: Person): Promise<{ id: string }> {
  const made =
    assigned.get(who.email) ??
    assignRole(
      f.deps.db,
      { role: "viewer", subject_kind: "person", subject: who.email },
      principals.admin,
    );
  assigned.set(who.email, made);
  return made;
}

async function devSignInAs(who: Person): Promise<string> {
  await assign(who);
  return devSignIn(who.email);
}

describe("whose email and groups count", () => {
  it("gives no person role to an email the provider does not call verified", async () => {
    const verified = f.person("analyst");
    const unverified = f.person("app-reader");
    await Promise.all([assign(verified), assign(unverified)]);
    expect(errorOf((await f.signIn(verified, OIDC)).callback)).toBeNull();
    const refused = (await f.signIn(unverified, UNVERIFIED_OIDC)).callback;
    expect(errorOf(refused)).toBe("not_assigned");
  });

  it("gives no role for an Entra group to another provider's token that names its id", async () => {
    const leader = f.person("leader");
    await assignRole(
      f.deps.db,
      {
        role: "curator",
        subject_kind: "group",
        provider: MICROSOFT,
        subject: f.group("Directors"),
      },
      principals.admin,
    );
    // The mock's /oidc puts the person's Entra group ids in its groups claim.
    expect(errorOf((await f.signIn(leader, OIDC)).callback)).toBe(
      "not_assigned",
    );
  });
});

describe("which Google accounts vouch for their domain", () => {
  const expected = {
    tenant_id: null,
    app_client_id: null,
    authority: "https://login.example.com",
    google_id: "google",
  };
  const google = (hd: string | undefined) =>
    claimsOf(
      {
        method: "oauth",
        action: "sign-in",
        oauth: {
          providerId: "google",
          profile: hd === undefined ? {} : { hd },
        },
      },
      expected,
      { address: "someone@company.example", verified: true },
    );

  it("vouches for the email's domain only as a Workspace account of that domain", () => {
    expect(google("company.example")).toMatchObject({
      claims: { provider: "google", domain_verified: true },
    });
    for (const hd of [undefined, "other.example"])
      expect(google(hd)).toMatchObject({ claims: { domain_verified: false } });
  });
});

describe("which Microsoft tokens are taken", () => {
  const expected = {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    app_client_id: "app",
    authority: "https://login.example.com/",
    google_id: null,
  };
  const token = {
    iss: "https://login.example.com/11111111-1111-4111-8111-111111111111/v2.0",
    aud: "app",
    tid: expected.tenant_id,
    oid: "9a1c0d5e-2b2f-4f6a-9f00-000000000001",
  };

  it("accepts only the configured tenant's issuer, for this app, about a member of that tenant", () => {
    expect(microsoftClaims(token, expected)?.tenant_member).toBe(true);
    const other = "22222222-2222-4222-8222-222222222222";
    for (const changed of [
      { tid: other },
      { iss: `https://login.example.com/${other}/v2.0` },
      { aud: "another-app" },
      { oid: "" },
    ])
      expect(microsoftClaims({ ...token, ...changed }, expected)).toBeNull();
  });

  it("carries the tenant id and the side of the mock it checked the token against", () => {
    expect(microsoftClaims(token, expected)).toMatchObject({
      checked_tenant_id: expected.tenant_id,
      checked_on_mock: false,
    });
    const upper = expected.tenant_id.toUpperCase();
    const mock = "http://localhost:4010";
    expect(
      microsoftClaims(
        { ...token, iss: `${mock}/${upper}/v2.0`, tid: upper },
        { ...expected, tenant_id: upper, authority: `${mock}/` },
      ),
    ).toMatchObject({
      checked_tenant_id: expected.tenant_id,
      checked_on_mock: true,
    });
  });

  it("matches the UPN, not an email Entra did not verify", async () => {
    const unverified = `${randomUUID()}@untrusted.example`;
    const who = {
      ...f.person("outsider"),
      object_id: randomUUID(),
      email: unverified,
      user_principal_name: `${randomUUID()}@sample.example`,
      group_ids: [],
    };
    f.tenant.people.push(who);
    await assignRole(
      f.deps.db,
      { role: "admin", subject_kind: "person", subject: unverified },
      principals.admin,
    );
    await f.settings.set("access.default_role", "none");
    try {
      expect(errorOf((await f.signIn(who, MICROSOFT)).callback)).toBe(
        "not_assigned",
      );
      await assignRole(
        f.deps.db,
        {
          role: "viewer",
          subject_kind: "person",
          subject: who.user_principal_name,
        },
        principals.admin,
      );
      expect(errorOf((await f.signIn(who, MICROSOFT)).callback)).toBeNull();
      expect(await userIdOf(who.user_principal_name)).toBeDefined();
    } finally {
      await f.settings.set("access.default_role", "viewer");
    }
  });

  it("stops counting a returning person's stored email once the token no longer vouches for it", async () => {
    const stored = `${randomUUID()}@untrusted.example`;
    // The mock sets xms_edov when the email's domain is the UPN's.
    const who = {
      ...f.person("outsider"),
      object_id: randomUUID(),
      email: stored,
      user_principal_name: `${randomUUID()}@untrusted.example`,
      group_ids: [],
    };
    f.tenant.people.push(who);
    await assignRole(
      f.deps.db,
      { role: "admin", subject_kind: "person", subject: stored },
      principals.admin,
    );
    expect(errorOf((await f.signIn(who, MICROSOFT)).callback)).toBeNull();
    who.user_principal_name = `${randomUUID()}@sample.example`;
    const { callback, cookie } = await f.signIn(who, MICROSOFT);
    expect(errorOf(callback)).toBeNull();
    const me = await f.request("/api/v1/me", { headers: { cookie } });
    expect(((await me.json()) as { roles: string[] }).roles).toEqual([
      "viewer",
    ]);
    const [signedIn] = await f.deps.db
      .select()
      .from(personSignIn)
      .where(eq(personSignIn.user_id, await userIdOf(stored)));
    expect(signedIn?.domain_verified).toBe(false);
  });

  it("refuses an ID token a browser posts, and sets no cookie", async () => {
    const id_token = await microsoftIdToken(f.person("sales-viewer"));
    const response = await f.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        provider: "microsoft",
        idToken: { token: id_token },
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("Better Auth's paths", () => {
  it("answers 404 to a signed-in person on every path sign-in does not use", async () => {
    const cookie = await devSignInAs(f.person("viewer"));
    for (const [method, path] of [
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/revoke-sessions"],
      ["POST", "/api/auth/sso/register"],
      ["GET", "/api/auth/sso/callback/sample_oidc"],
      ["GET", "/api/auth/list-accounts"],
    ] as const) {
      const response = await f.request(path, {
        method,
        headers: { ...json, cookie },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, path).toBe(404);
    }
  });

  it("never repeats the session token in a JSON answer", async () => {
    const cookie = await devSignInAs(f.person("viewer"));
    const token = /session_token=([^.;]+)/.exec(cookie)?.[1];
    expect(token).toBeDefined();
    const response = await f.request("/api/auth/get-session", {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"user"');
    expect(body).not.toContain(String(token));
  });

  it("keeps no provider token on the account a Microsoft sign-in makes, or on the next sign-in", async () => {
    // The admin signs in with Microsoft again below, to be refused a second provider.
    const who = f.person("admin");
    for (let round = 0; round < 2; round += 1) {
      expect(errorOf((await f.signIn(who, MICROSOFT)).callback)).toBeNull();
      const rows = await f.deps.db
        .select({
          access: account.accessToken,
          refresh: account.refreshToken,
          id: account.idToken,
          access_expires: account.accessTokenExpiresAt,
          refresh_expires: account.refreshTokenExpiresAt,
        })
        .from(account)
        .where(eq(account.userId, await userIdOf(who.email)));
      expect(rows).toEqual([
        {
          access: null,
          refresh: null,
          id: null,
          access_expires: null,
          refresh_expires: null,
        },
      ]);
    }
  });

  it("logs Better Auth's own lines with their message only", async () => {
    const response = await f.request("/api/auth/callback/microsoft?code=c");
    expect(response.status).toBe(302);
    const lines = f.logged.filter((line) => line.level === "error");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.fields).toBeUndefined();
  });
});

describe("sessions and passkeys", () => {
  it("ends a session 7 days after sign-in", async () => {
    const cookie = await devSignInAs(f.person("leader"));
    const token = /session_token=([^.;]+)/.exec(cookie)?.[1] ?? "";
    const [row] = await f.deps.db
      .select({
        hours: sql<number>`extract(epoch from ${session.expiresAt} - ${session.createdAt}) / 3600`,
      })
      .from(session)
      .where(eq(session.token, token));
    expect(Math.round(Number(row?.hours))).toBe(7 * 24);
  });

  it("never moves a session's end, however busy it is", async () => {
    const who = f.person("viewer");
    await assign(who);
    const signedIn = await f.request("/api/auth/dev/sign-in", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: who.email }),
    });
    expect(signedIn.status).toBe(200);
    const sessionCookie = signedIn.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("session_token="));
    expect(sessionCookie).toMatch(/Max-Age=604800(;|$)/);
    const cookie = cookies(signedIn);
    const token = /session_token=([^.;]+)/.exec(cookie)?.[1] ?? "";
    // Better Auth reads Date.now(), not deps.clock: two days into the session,
    // past its default updateAge of a day, a sliding session would renew.
    const [backdated] = await f.deps.db
      .update(session)
      .set({
        createdAt: sql`now() - interval '2 days'`,
        updatedAt: sql`now() - interval '2 days'`,
        expiresAt: sql`now() + interval '5 days'`,
      })
      .where(eq(session.token, token))
      .returning({ expiresAt: session.expiresAt });
    expect(backdated).toBeDefined();
    const read = await f.request("/api/auth/get-session", {
      headers: { cookie },
    });
    expect(read.status).toBe(200);
    expect(read.headers.getSetCookie().join(";")).not.toMatch(
      /session_token=[^;]/,
    );
    expect(
      (await f.request("/api/v1/me", { headers: { cookie } })).status,
    ).toBe(200);
    const [after] = await f.deps.db
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.token, token));
    expect(after?.expiresAt).toEqual(backdated?.expiresAt);
  });

  it("answers 403 on the next request once no assignment reaches the person", async () => {
    const who = f.person("outsider");
    const granted = await assign(who);
    const cookie = await devSignIn(who.email);
    const me = () => f.request("/api/v1/me", { headers: { cookie } });
    expect((await me()).status).toBe(200);
    await revokeRole(f.deps.db, granted.id);
    const refused = await me();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "refused",
      message: NOT_ASSIGNED,
    });
  });

  it("refuses a passkey sign-in a week after the person's last provider sign-in", async () => {
    const who = f.person("sales-viewer");
    await assign(who);
    await devSignIn(who.email);
    const id = await userIdOf(who.email);
    const passkey = () =>
      admitSession(f.deps, id, "/passkey/verify-authentication");
    await expect(passkey()).resolves.toBe("passkey");
    await f.deps.db
      .update(personSignIn)
      .set({ signed_in_at: sql`now() - interval '8 days'` })
      .where(eq(personSignIn.user_id, id));
    await expect(passkey()).rejects.toMatchObject({
      body: { code: "sign_in_again", message: PASSKEY_STALE },
    });
  });

  it("registers and signs in only a passkey whose device verified the person", async () => {
    await f.settings.set("sign_in.passkeys", true);
    f.advance(31_000);
    try {
      const key = softwarePasskey(
        new URL(TEST_PUBLIC_BASE_URL).hostname,
        TEST_PUBLIC_BASE_URL,
      );
      const cookie = await devSignInAs(f.person("revoked"));
      const register = async (userVerified: boolean) => {
        const options = await f.request(
          "/api/auth/passkey/generate-register-options",
          { headers: { cookie } },
        );
        const { challenge, authenticatorSelection } =
          (await options.json()) as {
            challenge: string;
            authenticatorSelection: unknown;
          };
        expect(authenticatorSelection).toMatchObject({
          userVerification: "required",
        });
        return f.request("/api/auth/passkey/verify-registration", {
          method: "POST",
          headers: { ...json, cookie: `${cookie}; ${cookies(options)}` },
          body: JSON.stringify(key.registration(challenge, userVerified)),
        });
      };
      expect((await register(false)).status).toBe(403);
      expect((await register(true)).status).toBe(200);

      const signIn = async (userVerified: boolean) => {
        const options = await f.request(
          "/api/auth/passkey/generate-authenticate-options",
        );
        const { challenge } = (await options.json()) as { challenge: string };
        return f.request("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { ...json, cookie: cookies(options) },
          body: JSON.stringify(key.assertion(challenge, userVerified)),
        });
      };
      const unverified = await signIn(false);
      expect(unverified.status).toBe(403);
      expect(unverified.headers.getSetCookie().join(";")).not.toMatch(
        /session_token=[^;]/,
      );
      const verified = await signIn(true);
      expect(verified.status).toBe(200);
      expect(verified.headers.getSetCookie().join(";")).toMatch(
        /session_token=[^;]/,
      );
    } finally {
      await f.settings.set("sign_in.passkeys", false);
      f.advance(31_000);
    }
  });

  it("ends a passkey's session when the provider sign-in behind it stops counting", async () => {
    await f.settings.set("sign_in.passkeys", true);
    f.advance(31_000);
    try {
      const key = softwarePasskey(
        new URL(TEST_PUBLIC_BASE_URL).hostname,
        TEST_PUBLIC_BASE_URL,
      );
      const who = f.person("leader");
      const cookie = await devSignInAs(who);
      const options = await f.request(
        "/api/auth/passkey/generate-register-options",
        { headers: { cookie } },
      );
      const { challenge } = (await options.json()) as { challenge: string };
      const registered = await f.request(
        "/api/auth/passkey/verify-registration",
        {
          method: "POST",
          headers: { ...json, cookie: `${cookie}; ${cookies(options)}` },
          body: JSON.stringify(key.registration(challenge, true)),
        },
      );
      expect(registered.status).toBe(200);
      await f.deps.db
        .update(personSignIn)
        .set({ signed_in_at: sql`now() - interval '5 days'` })
        .where(eq(personSignIn.user_id, await userIdOf(who.email)));

      const start = await f.request(
        "/api/auth/passkey/generate-authenticate-options",
      );
      const started = (await start.json()) as { challenge: string };
      const signedIn = await f.request(
        "/api/auth/passkey/verify-authentication",
        {
          method: "POST",
          headers: { ...json, cookie: cookies(start) },
          body: JSON.stringify(key.assertion(started.challenge, true)),
        },
      );
      expect(signedIn.status).toBe(200);
      const token = /session_token=([^.;]+)/.exec(cookies(signedIn))?.[1];
      const [row] = await f.deps.db
        .select({
          hours: sql<number>`extract(epoch from ${session.expiresAt} - now()) / 3600`,
          method: session.sign_in_method,
        })
        .from(session)
        .where(eq(session.token, String(token)));
      expect(row?.method).toBe("passkey");
      expect(Math.round(Number(row?.hours))).toBe(2 * 24);
    } finally {
      await f.settings.set("sign_in.passkeys", false);
      f.advance(31_000);
    }
  });
});

describe("linking accounts", () => {
  it("never joins a second provider's sign-in to the account another made for the same email", async () => {
    const who = f.person("admin");
    await assign(who);
    expect(errorOf((await f.signIn(who, MICROSOFT)).callback)).toBeNull();
    const { callback } = await f.signIn(who, OIDC);
    expect(errorOf(callback)).toBe("account not linked");
    expect(callback.headers.getSetCookie().join(";")).not.toMatch(
      /session_token=[^;]/,
    );
  });
});

/** An ID token the mock's Microsoft identity issued for this app, through the code flow a browser would run. */
async function microsoftIdToken(who: Person): Promise<string> {
  const authority = await f.settings.get("powerbi.authority");
  const client_id = String(await f.settings.get("powerbi.app_client_id"));
  const base = `${authority}/${f.tenant.tenant_id}/oauth2/v2.0`;
  const redirect_uri = `${TEST_PUBLIC_BASE_URL}/api/auth/callback/microsoft`;
  const verifier = randomBytes(32).toString("base64url");
  f.actAs(who);
  const authorized = await request(
    `${base}/authorize?${new URLSearchParams({
      client_id,
      response_type: "code",
      redirect_uri,
      scope: "openid profile email",
      state: "state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString()}`,
  );
  await authorized.body.dump();
  const code = new URL(String(authorized.headers.location)).searchParams.get(
    "code",
  );
  const redeemed = await request(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri,
      code_verifier: verifier,
      client_id,
      client_secret: "sample-app-secret",
    }).toString(),
  });
  const { id_token } = (await redeemed.body.json()) as { id_token: string };
  return id_token;
}
