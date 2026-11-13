// When a way of signing in is turned off, or a provider moved to another
// issuer or kind, the sessions it made end, and its sign-ins stop counting
// for groups and for a passkey's freshness, so a passkey session ends by
// the sign-ins left. A person left with no account at a way of signing in
// still on loses every session and grant.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { SignInProvider } from "../../context.js";
import { auditEvent } from "../../db/schema/audit.js";
import {
  account,
  oauthClient,
  oauthConsent,
  session,
  user,
} from "../../db/schema/auth.js";
import { personSignIn } from "../../db/schema/roles.js";
import { createSettingsStore } from "../settings/store.js";
import { setSetting } from "./settings.js";

afterAll(closeTestPools);

const base = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = {
  ...base,
  settings: createSettingsStore(base.db, {}),
  principal: principals.admin,
};

const OKTA: SignInProvider = {
  id: "okta",
  kind: "oidc",
  label: "Okta",
  client_id: "abc",
  issuer: "https://example.okta.com",
};
const GOOGLE: SignInProvider = {
  id: "google",
  kind: "google",
  label: "Google",
  client_id: "def",
  issuer: null,
};

const saveProviders = (providers: SignInProvider[]) =>
  setSetting(admin, "sign_in.providers", providers, { save_failing: true });

/** A person signed in with `method` a day ago, holding a session it made. */
async function signedInWith(method: string) {
  const id = randomUUID();
  await admin.db.insert(user).values({
    id,
    name: method,
    email: `${id}@sample.example`,
    emailVerified: true,
  });
  const token = randomUUID();
  await admin.db.insert(session).values({
    id: randomUUID(),
    userId: id,
    token,
    expiresAt: new Date(Date.now() + 86_400_000),
    sign_in_method: method,
  });
  if (method !== "passkey")
    await admin.db.insert(personSignIn).values({
      user_id: id,
      provider: method,
      signed_in_at: new Date(Date.now() - 86_400_000),
      group_ids: ["sales"],
    });
  return { id, token, method };
}

type Signed = Awaited<ReturnType<typeof signedInWith>>;

async function hasSession({ token }: Signed): Promise<boolean> {
  const rows = await admin.db
    .select({ id: session.id })
    .from(session)
    .where(eq(session.token, token));
  return rows.length > 0;
}

/** Whether the person's sign-in with their method still counts: within the last week. */
async function signInCounts({ id, method }: Signed): Promise<boolean> {
  const [row] = await admin.db
    .select({ at: personSignIn.signed_in_at })
    .from(personSignIn)
    .where(
      and(eq(personSignIn.user_id, id), eq(personSignIn.provider, method)),
    );
  if (row === undefined) throw new Error(`no ${method} sign-in for ${id}`);
  return row.at.getTime() > Date.now() - 7 * 86_400_000;
}

async function lastSignedOut(key: string): Promise<unknown> {
  const [row] = await admin.db
    .select({ detail: auditEvent.detail })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, "admin.setting.set"),
        eq(auditEvent.resource_id, key),
      ),
    )
    .orderBy(desc(auditEvent.id))
    .limit(1);
  return row?.detail.signed_out_user_ids;
}

describe("a sign-in provider that is removed or moved", () => {
  let okta: Signed;
  let google: Signed;

  beforeEach(async () => {
    await saveProviders([OKTA, GOOGLE]);
    okta = await signedInWith("okta");
    google = await signedInWith("google");
  });

  it("keeps its sessions and sign-ins while it keeps its kind and issuer", async () => {
    await saveProviders([
      { ...OKTA, label: "Okta SSO", client_id: "xyz" },
      GOOGLE,
    ]);
    for (const person of [okta, google]) {
      expect(await hasSession(person)).toBe(true);
      expect(await signInCounts(person)).toBe(true);
    }
  });

  it("ends its sessions and stops its sign-ins counting when it moves to another issuer", async () => {
    await saveProviders([
      { ...OKTA, issuer: "https://collector.example.net" },
      GOOGLE,
    ]);
    expect(await hasSession(okta)).toBe(false);
    expect(await signInCounts(okta)).toBe(false);
    expect(await hasSession(google)).toBe(true);
    expect(await signInCounts(google)).toBe(true);
    const signedOut = await lastSignedOut("sign_in.providers");
    expect(signedOut).toContain(okta.id);
    expect(signedOut).not.toContain(google.id);
  });

  it("ends its sessions and stops its sign-ins counting when it changes kind", async () => {
    await saveProviders([{ ...OKTA, kind: "google", issuer: null }, GOOGLE]);
    expect(await hasSession(okta)).toBe(false);
    expect(await signInCounts(okta)).toBe(false);
  });

  it("ends a removed Google provider's sessions and stops its sign-ins counting", async () => {
    await saveProviders([OKTA]);
    expect(await hasSession(google)).toBe(false);
    expect(await signInCounts(google)).toBe(false);
    expect(await hasSession(okta)).toBe(true);
    expect(await signInCounts(okta)).toBe(true);
  });
});

describe("turning passkeys off", () => {
  it("ends every passkey session and keeps the others", async () => {
    await setSetting(admin, "sign_in.passkeys", true, { save_failing: true });
    const passkey = await signedInWith("passkey");
    const okta = await signedInWith("okta");
    await setSetting(admin, "sign_in.passkeys", false, { save_failing: true });
    expect(await hasSession(passkey)).toBe(false);
    expect(await hasSession(okta)).toBe(true);
    expect(await lastSignedOut("sign_in.passkeys")).toEqual([passkey.id]);
  });
});

describe("a person with no account left at a way of signing in still on", () => {
  /** Gives the person an account at each provider and a grant to a new MCP client. */
  async function withAccountsAndGrant(person: Signed, providers: string[]) {
    for (const providerId of providers)
      await admin.db.insert(account).values({
        id: randomUUID(),
        accountId: randomUUID(),
        providerId,
        userId: person.id,
      });
    const clientId = randomUUID();
    await admin.db.insert(oauthClient).values({
      id: randomUUID(),
      clientId,
      redirectUris: [],
      createdAt: new Date(),
    });
    await admin.db.insert(oauthConsent).values({
      id: randomUUID(),
      clientId,
      userId: person.id,
      scopes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  async function hasGrant({ id }: Signed): Promise<boolean> {
    const rows = await admin.db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, id));
    return rows.length > 0;
  }

  beforeEach(async () => {
    await saveProviders([OKTA, GOOGLE]);
  });

  it("loses their MCP and CLI grants and every session, a passkey's too", async () => {
    const stranded = await signedInWith("okta");
    await withAccountsAndGrant(stranded, ["okta"]);
    const passkey = { ...stranded, token: randomUUID(), method: "passkey" };
    await admin.db.insert(session).values({
      id: randomUUID(),
      userId: stranded.id,
      token: passkey.token,
      expiresAt: new Date(Date.now() + 86_400_000),
      sign_in_method: "passkey",
    });
    await saveProviders([GOOGLE]);
    expect(await hasGrant(stranded)).toBe(false);
    expect(await hasSession(passkey)).toBe(false);
    expect(await lastSignedOut("sign_in.providers")).toContain(stranded.id);
  });

  it("loses them when the provider moves to another issuer too", async () => {
    const stranded = await signedInWith("okta");
    await withAccountsAndGrant(stranded, ["okta"]);
    await saveProviders([
      { ...OKTA, issuer: "https://collector.example.net" },
      GOOGLE,
    ]);
    expect(await hasGrant(stranded)).toBe(false);
  });

  it("keeps the grants of a person who signs in another way as well", async () => {
    const both = await signedInWith("okta");
    await withAccountsAndGrant(both, ["okta", "microsoft"]);
    const google = await signedInWith("google");
    await withAccountsAndGrant(google, ["google"]);
    await saveProviders([GOOGLE]);
    expect(await hasGrant(both)).toBe(true);
    expect(await hasGrant(google)).toBe(true);
  });

  it("counts a Google provider's people by Google's own account id", async () => {
    const google = await signedInWith("google");
    await withAccountsAndGrant(google, ["google"]);
    await saveProviders([OKTA]);
    expect(await hasGrant(google)).toBe(false);
  });

  it("loses them when their provider goes after password sign-in was turned off", async () => {
    await admin.settings.set("sign_in.email_password", true, admin.principal);
    const person = await signedInWith("okta");
    await withAccountsAndGrant(person, ["credential", "okta"]);
    await setSetting(admin, "sign_in.email_password", false, {
      save_failing: true,
    });
    expect(await hasGrant(person)).toBe(true);
    await saveProviders([GOOGLE]);
    expect(await hasGrant(person)).toBe(false);
    expect(await lastSignedOut("sign_in.providers")).toContain(person.id);
  });

  it("loses them when password sign-in is turned off after their provider went", async () => {
    await admin.settings.set("sign_in.email_password", true, admin.principal);
    const person = await signedInWith("okta");
    await withAccountsAndGrant(person, ["credential", "okta"]);
    await saveProviders([GOOGLE]);
    expect(await hasGrant(person)).toBe(true);
    await setSetting(admin, "sign_in.email_password", false, {
      save_failing: true,
    });
    expect(await hasGrant(person)).toBe(false);
    expect(await lastSignedOut("sign_in.email_password")).toContain(person.id);
  });

  it("loses them on the next change when their provider went before the sweep existed", async () => {
    // Okta removed by a release that swept nobody: the account is left, the provider gone.
    const person = await signedInWith("okta");
    await withAccountsAndGrant(person, ["okta"]);
    await admin.settings.set("sign_in.providers", [GOOGLE], admin.principal);
    expect(await hasGrant(person)).toBe(true);
    await saveProviders([]);
    expect(await hasGrant(person)).toBe(false);
    expect(await lastSignedOut("sign_in.providers")).toContain(person.id);
  });
});

describe("a passkey session whose provider sign-in stops counting", () => {
  const DAY = 86_400_000;

  /**
   * A person who signed in with each method this many days ago, holding an
   * account at each and a passkey session that ends a week after the latest,
   * as sessionEnd set it.
   */
  async function withPasskey(days_ago: Record<string, number>) {
    const id = randomUUID();
    await admin.db.insert(user).values({
      id,
      name: "passkey",
      email: `${id}@sample.example`,
      emailVerified: true,
    });
    const now = Date.now();
    const signed_in = Object.fromEntries(
      Object.entries(days_ago).map(([method, days]) => [
        method,
        new Date(now - days * DAY),
      ]),
    );
    for (const [provider, at] of Object.entries(signed_in)) {
      await admin.db.insert(personSignIn).values({
        user_id: id,
        provider,
        signed_in_at: at,
      });
      await admin.db.insert(account).values({
        id: randomUUID(),
        accountId: randomUUID(),
        providerId: provider,
        userId: id,
      });
    }
    const latest = Math.max(
      ...Object.values(signed_in).map((d) => d.getTime()),
    );
    const token = randomUUID();
    await admin.db.insert(session).values({
      id: randomUUID(),
      userId: id,
      token,
      expiresAt: new Date(latest + 7 * DAY),
      sign_in_method: "passkey",
    });
    return { id, token, method: "passkey", now };
  }

  async function endsAt({ token }: Signed): Promise<Date | undefined> {
    const [row] = await admin.db
      .select({ at: session.expiresAt })
      .from(session)
      .where(eq(session.token, token));
    return row?.at;
  }

  beforeEach(async () => {
    await saveProviders([OKTA, GOOGLE]);
  });

  it("ends when the provider moves and the person's other sign-in is more than a week old", async () => {
    const person = await withPasskey({ okta: 0.1, microsoft: 10 });
    await saveProviders([
      { ...OKTA, issuer: "https://collector.example.net" },
      GOOGLE,
    ]);
    expect(await hasSession(person)).toBe(false);
    expect(await lastSignedOut("sign_in.providers")).toContain(person.id);
  });

  it("ends a week after the person's remaining sign-in when the provider is removed", async () => {
    const person = await withPasskey({ okta: 0.1, microsoft: 3 });
    await saveProviders([GOOGLE]);
    expect(await endsAt(person)).toEqual(new Date(person.now + 4 * DAY));
    expect(await lastSignedOut("sign_in.providers")).not.toContain(person.id);
  });

  it("ends when password sign-in is turned off and the person's other sign-in is more than a week old", async () => {
    await admin.settings.set("sign_in.email_password", true, admin.principal);
    const person = await withPasskey({ credential: 0.1, microsoft: 10 });
    await setSetting(admin, "sign_in.email_password", false, {
      save_failing: true,
    });
    expect(await hasSession(person)).toBe(false);
    expect(await lastSignedOut("sign_in.email_password")).toContain(person.id);
  });

  it("keeps its end when the sign-in behind it still counts", async () => {
    const person = await withPasskey({ okta: 3, microsoft: 0.1 });
    const before = await endsAt(person);
    await saveProviders([GOOGLE]);
    expect(await endsAt(person)).toEqual(before);
  });
});
