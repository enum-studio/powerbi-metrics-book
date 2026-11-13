import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testPool,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import {
  cookies,
  freshPeer,
  fromSpa,
  startOAuth,
} from "../../../test/sign-in-support.js";
import { account, session, user, verification } from "../../db/schema/auth.js";
import { createApp } from "../../app.js";
import { createGuardedFetcher } from "../../http/fetcher.js";
import { invite as inviteTable } from "../../db/schema/invites.js";
import { personSignIn } from "../../db/schema/roles.js";
import { auditEvent } from "../../db/schema/audit.js";
import { createSettingsStore } from "../settings/store.js";
import { buildAuth, createAuth, readInputs } from "./better-auth.js";
import { setSetting } from "../admin/settings.js";
import { sendInviteEmail, sendPasswordLink } from "./email.js";
import { assignRole } from "./roles.js";

const settings = new MemorySettings();
const secrets = new MemorySecrets();
let now = new Date();
const mock = await startMockPowerBi({ tenant: sampleTenant() });
const f = startOAuth({
  settings,
  secrets,
  clock: () => now,
  access: cerbosAccess(settings),
  fetcher: createGuardedFetcher({
    nodeEnv: "test",
    allowedOrigins: () => Promise.resolve([mock.url]),
  }),
});
let adminCookie = "";
let adminEmail = "";
const password = "sample-password-12345";
const email = `${randomUUID()}@sample.example`;
const post = (path: string, body: object, cookie = "") =>
  f.request(path, {
    ...fromSpa(cookie, body),
    headers: {
      cookie,
      origin: "https://metrics.example.com",
      "content-type": "application/json",
      host: "attacker.example",
    },
  });
const advance = (ms = 31_000) => {
  now = new Date(now.getTime() + ms);
};
const token = () =>
  new URLSearchParams(
    new URL(mock.outbox.at(-1)?.text.split("\n").at(-1) ?? "").hash.slice(1),
  ).get("token");
const invite = (mail = email) =>
  post(
    "/api/v1/admin/people/invites",
    { emails: [mail], role: "viewer", delivery: "email" },
    adminCookie,
  );
const accept = (value: string | null) =>
  post("/api/auth/invites/accept", { token: value, password });
/** A token as every invite's is shaped, that names no invite. */
const UNKNOWN = "A".repeat(43);
/** An open email invite for someone already a user, whom inviting now refuses. */
const opened = async (mail: string) => {
  const value = randomBytes(32).toString("base64url");
  await f.deps.db.insert(inviteTable).values({
    email: mail,
    role: "viewer",
    token_sha256: createHash("sha256").update(value).digest("hex"),
    delivery: "email",
    invited_by: principals.admin.id,
    last_sent_at: now,
    expires_at: new Date(now.getTime() + 86400_000),
  });
  return value;
};

beforeAll(async () => {
  const person = await f.person();
  await assignRole(
    f.deps.db,
    { role: "admin", subject_kind: "person", subject: person.email },
    principals.admin,
  );
  adminCookie = person.cookie;
  adminEmail = person.email;
  await settings.set("email.base_url", mock.url);
});
afterAll(async () => {
  await mock.close();
  await closeTestPools();
});

it("requires the key and sender before enabling password sign-in", async () => {
  const context = {
    ...f.deps,
    settings: createSettingsStore(f.deps.db, {}),
    principal: principals.admin,
  };
  await expect(
    setSetting(context, "sign_in.email_password", true, { save_failing: true }),
  ).rejects.toThrow("resend_api_key");
  await secrets.write("resend_api_key", "sample-resend-key");
  await expect(
    setSetting(context, "sign_in.email_password", true, { save_failing: true }),
  ).rejects.toThrow("email.from");
  await settings.set("email.from", "invites@sample.example");
});

it("refuses sign-up with password sign-in off and on", async () => {
  for (const enabled of [false, true]) {
    await settings.set("sign_in.email_password", enabled);
    advance();
    const { instance } = await buildAuth(f.deps, await readInputs(f.deps));
    await expect(
      instance.api.signUpEmail({ body: { email, password, name: email } }),
    ).rejects.toMatchObject({
      body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" },
    });
    expect(
      (await post("/api/auth/sign-up/email", { email, password, name: email }))
        .ok,
    ).toBe(false);
  }
});

it("admits only a fresh invite, verifies its mailbox, and spends it once", async () => {
  const unknown = await accept(UNKNOWN);
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ code: "INVALID_TOKEN" });
  expect((await invite()).status).toBe(200);
  const value = token();
  const link = new URL(mock.outbox.at(-1)?.text.split("\n").at(-1) ?? "");
  expect(link.origin).toBe("https://metrics.example.com");
  expect(link.pathname).toBe("/invite");
  expect(link.searchParams.has("token")).toBe(false);
  expect(new URLSearchParams(link.hash.slice(1)).get("token")).toBe(value);
  expect(link.search).toBe("");
  expect(mock.outbox.at(-1)?.html).toContain(`/invite#token=${String(value)}"`);
  expect(mock.outbox.at(-1)?.subject).toBe(
    `${adminEmail} invited you to Power BI Metrics Book`,
  );
  expect(mock.outbox.at(-1)?.text).toContain("as a Viewer.");
  const expiry = new Date(now.getTime() + 7 * 86400_000).toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
  );
  expect(mock.outbox.at(-1)?.text).toContain(
    `This invite expires on ${expiry}.`,
  );
  expect(Object.keys(mock.outbox.at(-1) ?? {}).sort()).toEqual([
    "from",
    "html",
    "subject",
    "text",
    "to",
  ]);
  const response = await accept(value);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const [person] = await f.deps.db
    .select()
    .from(user)
    .where(eq(user.email, email));
  expect(person?.emailVerified).toBe(true);
  const spent = await accept(value);
  expect(spent.status).toBe(400);
  expect(await spent.json()).toMatchObject({ code: "INVALID_TOKEN" });
  await settings.set("sign_in.email_password", false);
  advance();
  expect((await post("/api/auth/sign-in/email", { email, password })).ok).toBe(
    false,
  );
  await settings.set("sign_in.email_password", true);
  advance();
  expect(
    (await post("/api/auth/sign-in/email", { email, password })).status,
  ).toBe(200);
});

it("ends an earlier invite and expires an invite at 7 days", async () => {
  const mailbox = `${randomUUID()}@sample.example`;
  await invite(mailbox);
  const earlier = token();
  await invite(mailbox);
  const latest = token();
  expect((await accept(earlier)).status).toBe(400);
  const created = now;
  advance(7 * 86400_000 - 60_000);
  expect((await accept(latest)).status).toBe(200);
  now = created;
  await invite(`${randomUUID()}@sample.example`);
  const expiring = token();
  advance(7 * 86400_000 + 60_000);
  const expired = await accept(expiring);
  expect(expired.status).toBe(400);
  expect(await expired.json()).toMatchObject({ code: "INVALID_TOKEN" });
  now = created;
  advance();
});

it("does equal forgot-password work, hashes reset tokens, and revokes other sessions", async () => {
  const signed = await post("/api/auth/sign-in/email", { email, password });
  const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
  const before = mock.outbox.length;
  const gate = Promise.withResolvers<undefined>();
  const original = f.deps.fetcher.fetchFixed.bind(f.deps.fetcher);
  const sending = vi
    .spyOn(f.deps.fetcher, "fetchFixed")
    .mockImplementation(async (...args) => {
      await gate.promise;
      return original(...args);
    });
  const known = await post("/api/auth/email/forgot-password", { email });
  expect(mock.outbox.length).toBe(before);
  gate.resolve(undefined);
  await vi.waitFor(() => {
    expect(mock.outbox.length).toBe(before + 1);
  });
  sending.mockRestore();
  const reset = token();
  expect(mock.outbox.at(-1)?.subject).toBe("Reset your password");
  expect(mock.outbox.at(-1)?.text).toContain("1 hour");
  expect(
    new URL(mock.outbox.at(-1)?.text.split("\n").at(-1) ?? "").searchParams.get(
      "kind",
    ),
  ).toBe("reset");
  const unknown = await post("/api/auth/email/forgot-password", {
    email: `${randomUUID()}@sample.example`,
  });
  expect(known.status).toBe(200);
  expect(await known.json()).toEqual(await unknown.json());
  expect(mock.outbox.length - before).toBe(1);
  const stored = await f.deps.db.select().from(verification);
  expect(stored.some((row) => row.identifier.includes(String(reset)))).toBe(
    false,
  );
  expect(
    (
      await post("/api/auth/reset-password", {
        token: reset,
        newPassword: password + "changed",
      })
    ).status,
  ).toBe(200);
  expect((await f.request("/api/v1/me", { headers: { cookie } })).status).toBe(
    401,
  );
  expect(
    (
      await post("/api/auth/reset-password", {
        token: reset,
        newPassword: password,
      })
    ).ok,
  ).toBe(false);
});

it("refuses invites from a non-admin", async () => {
  const viewer = await f.person();
  expect(
    (
      await post(
        "/api/v1/admin/people/invites",
        { emails: [email], role: "admin", delivery: "email" },
        viewer.cookie,
      )
    ).status,
  ).toBe(403);
});

it("refuses a provider user's invite without verifying or changing the user", async () => {
  const person = await f.person();
  const pending = await opened(person.email);
  await f.deps.db.insert(account).values({
    id: randomUUID(),
    userId: person.id,
    providerId: "microsoft",
    accountId: randomUUID(),
  });
  await f.deps.db
    .update(user)
    .set({ emailVerified: false })
    .where(eq(user.id, person.id));
  const unknown = await accept(UNKNOWN);
  const refused = await accept(pending);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual(await unknown.json());
  const [before] = await f.deps.db
    .select()
    .from(user)
    .where(eq(user.id, person.id));
  expect(before?.emailVerified).toBe(false);
  const looked = await post("/api/auth/invites/lookup", { token: pending });
  expect(await looked.json()).toMatchObject({
    state: "open",
    password_allowed: false,
  });
  const sent = mock.outbox.length;
  expect((await invite(person.email)).status).toBe(409);
  expect(mock.outbox.length).toBe(sent);
});

it("changes a password-only user's password and revokes every earlier session", async () => {
  const person = { email: `${randomUUID()}@sample.example` };
  await invite(person.email);
  const initial = await accept(token());
  const signed = await post("/api/auth/sign-in/email", {
    email: person.email,
    password,
  });
  const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
  const changed = await post(
    "/api/auth/change-password",
    {
      currentPassword: password,
      newPassword: password + "new",
      revokeOtherSessions: false,
    },
    cookie,
  );
  expect(changed.status).toBe(200);
  expect((await f.request("/api/v1/me", { headers: { cookie } })).status).toBe(
    401,
  );
  expect(
    (
      await f.request("/api/v1/me", {
        headers: {
          cookie: initial.headers.get("set-cookie")?.split(";")[0] ?? "",
        },
      })
    ).status,
  ).toBe(401);
});

it("limits email sign-in across different requesting addresses", async () => {
  const email = `${randomUUID()}@sample.example`;
  for (let i = 0; i < 5; i++)
    expect(
      (await post("/api/auth/sign-in/email", { email, password })).status,
    ).toBe(401);
  expect(
    (await post("/api/auth/sign-in/email", { email, password })).status,
  ).toBe(429);
});

it("expires reset tokens after one hour and rejects short passwords", async () => {
  const email = `${randomUUID()}@sample.example`;
  await invite(email);
  const value = token();
  expect(
    (
      await post("/api/auth/invites/accept", {
        token: value,
        password: "short",
      })
    ).status,
  ).toBe(400);
  expect((await accept(value)).status).toBe(200);
  const started = Date.now();
  expect(
    (await post("/api/auth/email/forgot-password", { email })).status,
  ).toBe(200);
  await vi.waitFor(() => {
    expect(mock.outbox.at(-1)?.subject).toBe("Reset your password");
  });
  const reset = token();
  const rows = await f.deps.db.select().from(verification);
  const [person] = await f.deps.db
    .select()
    .from(user)
    .where(eq(user.email, email));
  const stored = rows.find((row) => row.value === person?.id);
  expect(stored?.expiresAt.getTime()).toBe(now.getTime() + 3600_000);
  await f.deps.db
    .update(verification)
    .set({ expiresAt: new Date(started - 1) })
    .where(eq(verification.value, String(person?.id)));
  expect(
    (
      await post("/api/auth/reset-password", {
        token: reset,
        newPassword: password,
      })
    ).status,
  ).toBe(400);
});

it("replies identically without storing or sending for unknown and provider-only users", async () => {
  const person = await f.person();
  await f.deps.db.insert(account).values({
    id: randomUUID(),
    userId: person.id,
    providerId: "microsoft",
    accountId: randomUUID(),
  });
  const before = await f.deps.db.select().from(verification);
  const outbox = mock.outbox.length;
  const { instance } = await buildAuth(f.deps, await readInputs(f.deps));
  const lookups = vi.spyOn(
    (await instance.$context).internalAdapter,
    "findUserByEmail",
  );
  const replies = [];
  for (const email of [person.email, `${randomUUID()}@sample.example`]) {
    const response = await instance.handler(
      new Request(
        "https://metrics.example.com/api/auth/email/forgot-password",
        fromSpa("", { email }),
      ),
    );
    expect(response.status).toBe(200);
    replies.push(await response.json());
  }
  await vi.waitFor(() => {
    expect(lookups).toHaveBeenCalledTimes(2);
  });
  await Promise.all(
    lookups.mock.results.map((result): unknown => result.value),
  );
  expect(replies[0]).toEqual(replies[1]);
  expect(await f.deps.db.select().from(verification)).toEqual(before);
  expect(mock.outbox.length).toBe(outbox);
  const known = await instance.handler(
    new Request(
      "https://metrics.example.com/api/auth/email/forgot-password",
      fromSpa("", { email }),
    ),
  );
  expect(await known.json()).toEqual(replies[0]);
  await vi.waitFor(() => {
    expect(mock.outbox.length).toBe(outbox + 1);
  });
  expect(mock.outbox.length).toBe(outbox + 1);
  lookups.mockRestore();
});

it("refuses encoded password sign-in while the setting is off", async () => {
  const auth = createAuth(f.deps);
  await auth.handle(
    new Request(
      "https://metrics.example.com/api/auth/sign-in/email",
      fromSpa("", { email, password }),
    ),
    null,
  );
  await settings.set("sign_in.email_password", false);
  const answer = await auth.handle(
    new Request(
      "https://metrics.example.com/api/auth/sign-in/%65mail",
      fromSpa("", { email, password }),
    ),
    null,
  );
  expect(answer.status).toBe(403);
  await settings.set("sign_in.email_password", true);
});

it("ends password sessions and their passkey freshness when disabled, with an audit", async () => {
  advance(61_000);
  const signed = await post("/api/auth/sign-in/email", {
    email,
    password: password + "changed",
  });
  expect(signed.status).toBe(200);
  const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
  await setSetting(
    {
      ...f.deps,
      settings: createSettingsStore(f.deps.db, {}),
      principal: principals.admin,
    },
    "sign_in.email_password",
    false,
    { save_failing: false },
  );
  expect((await f.request("/api/v1/me", { headers: { cookie } })).status).toBe(
    401,
  );
  const rows = await f.deps.db.select().from(personSignIn);
  expect(
    rows
      .filter((row) => row.provider === "credential")
      .every(
        (row) => row.signed_in_at.getTime() < now.getTime() - 7 * 86400_000,
      ),
  ).toBe(true);
  const audits = await f.deps.db.select().from(auditEvent);
  expect(
    audits.some(
      (row) =>
        row.action === "admin.setting.set" &&
        row.resource_id === "sign_in.email_password" &&
        row.detail.after === false,
    ),
  ).toBe(true);
});

it("refuses a second open invite at the database", async () => {
  await invite(`${randomUUID()}@sample.example`);
  const [row] = await f.deps.db
    .select()
    .from(inviteTable)
    .where(
      eq(
        inviteTable.token_sha256,
        createHash("sha256").update(String(token())).digest("hex"),
      ),
    );
  expect(row).toBeDefined();
  if (!row) throw new Error("The invite was not stored.");
  await expect(
    f.deps.db
      .insert(inviteTable)
      .values({ ...row, id: randomUUID(), token_sha256: "0".repeat(64) }),
  ).rejects.toThrow();
});
it("escapes the invite role and link in HTML", async () => {
  await sendInviteEmail(f.deps, {
    to: email,
    inviter_name: "<b>Sample</b>",
    role_label: '<curator & "reviewer">',
    link: 'https://metrics.example.com/invite#token=sample"&',
    expires_at: now,
  });
  expect(mock.outbox.at(-1)?.html).toContain(
    "&lt;curator &amp; &quot;reviewer&quot;&gt;",
  );
  expect(mock.outbox.at(-1)?.html).toContain("&lt;b&gt;Sample&lt;/b&gt;");
  expect(mock.outbox.at(-1)?.html).toContain(
    'href="https://metrics.example.com/invite#token=sample&quot;&amp;"',
  );
  await sendPasswordLink(
    {
      ...f.deps,
      config: {
        ...f.deps.config,
        public_base_url: new URL("https://metrics&sample.example"),
      },
    },
    email,
    "sample",
  );
  expect(mock.outbox.at(-1)?.html).toContain(
    'href="https://metrics&amp;sample.example/set-password?kind=reset#token=sample"',
  );
});

const db = f.deps.db;
const oauth = startOAuth({ settings, secrets });
const send = (path: string, body: object, cookie = "") =>
  post(`/api/auth/${path}`, body, cookie);
async function passwordPerson() {
  const email = `${randomUUID()}@sample.example`;
  await invite(email);
  expect((await accept(token())).status).toBe(200);
  const signed = await send("sign-in/email", { email, password });
  expect(signed.status).toBe(200);
  const [row] = await db.select().from(user).where(eq(user.email, email));
  if (!row) throw new Error("The invited user was not saved.");
  return { ...row, cookie: cookies(signed) };
}

it.each(["disable", "reset", "change", "invite"])(
  "ends password-only OAuth grants on %s",
  async (action) => {
    const who = await passwordPerson();
    const newPassword = password + "new";
    const client = oauth.client();
    const mcp = await oauth.connect(who.cookie, client);
    const cli = await oauth.login(who.cookie);
    expect((await oauth.whoami(mcp.access_token)).status).toBe(200);
    expect((await oauth.bearer("/api/v1/me", cli.access_token)).status).toBe(
      200,
    );
    if (action === "disable") {
      await db.insert(session).values({
        id: randomUUID(),
        token: randomUUID(),
        userId: who.id,
        sign_in_method: "passkey",
        expiresAt: new Date(Date.now() + 12 * 3600_000),
        updatedAt: new Date(),
      });
      const stored = createSettingsStore(db, {});
      await stored.set("sign_in.email_password", true, principals.admin);
      await setSetting(
        { ...f.deps, settings: stored, principal: principals.admin },
        "sign_in.email_password",
        false,
        { save_failing: false },
      );
      const [audit] = await db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "admin.setting.set"))
        .orderBy(desc(auditEvent.id))
        .limit(1);
      expect.soft(audit?.detail.secrets_removed).toEqual([]);
      expect.soft(audit?.detail.signed_out_user_ids).toContain(who.id);
      expect
        .soft(
          await db
            .select({ id: session.id })
            .from(session)
            .where(eq(session.userId, who.id)),
        )
        .toEqual([]);
    } else if (action === "reset") {
      const before = mock.outbox.length;
      expect(
        (await send("email/forgot-password", { email: who.email })).status,
      ).toBe(200);
      await vi.waitFor(() => {
        expect(mock.outbox.length).toBe(before + 1);
      });
      const changed = await send("reset-password", {
        token: token(),
        newPassword,
      });
      expect(changed.status).toBe(200);
    } else if (action === "invite") {
      expect((await accept(await opened(who.email))).status).toBe(200);
    } else {
      const changed = await send(
        "change-password",
        { currentPassword: password, newPassword },
        who.cookie,
      );
      expect(changed.status).toBe(200);
    }
    const denied = await oauth.whoami(mcp.access_token);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await oauth.bearer("/api/v1/me", cli.access_token)).status).toBe(
      401,
    );
    for (const [client_id, refresh_token] of [
      [client.client_id, mcp.refresh_token],
      ["pbmb-cli", cli.refresh_token],
    ] as const) {
      const refused = await oauth.token({
        grant_type: "refresh_token",
        client_id,
        refresh_token,
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
    }
  },
);

it("logs the send failure's reason and still answers forgot password with 200", async () => {
  const who = await passwordPerson();
  const errors = vi.spyOn(f.deps.logger, "error");
  const sender = vi
    .spyOn(f.deps.fetcher, "fetchFixed")
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const answer = await send("email/forgot-password", { email: who.email });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    status: true,
    message: "Check your email for a password reset link.",
  });
  await vi.waitFor(() => {
    expect(errors).toHaveBeenCalledWith(
      "Password reset email failed.",
      expect.objectContaining<Record<string, unknown>>({
        message: "Resend refused the email; check the sender and key.",
        request_id: expect.any(String),
      }),
    );
  });
  sender.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const { instance } = await buildAuth(f.deps, await readInputs(f.deps));
  const request = new Request(
    "https://metrics.example.com/api/auth/email/forgot-password",
    fromSpa("", { email: who.email }),
  );
  request.headers.set("x-forwarded-for", freshPeer());
  const untracked = await instance.handler(request);
  expect(untracked.status).toBe(200);
  await vi.waitFor(() => {
    expect(errors).toHaveBeenCalledWith(
      "Password reset email failed.",
      expect.objectContaining<Record<string, unknown>>({ request_id: null }),
    );
  });
  expect(JSON.stringify(errors.mock.calls)).not.toContain("set-password");
  errors.mockRestore();
  sender.mockRestore();
});

it("refuses provider password changes and resets, and gives spent and made-up tokens the same refusal", async () => {
  const who = await passwordPerson();
  const resetToken = randomUUID();
  const body = { newPassword: password + "new" };
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: createHash("sha256")
      .update(`reset-password:${resetToken}`)
      .digest("base64url"),
    value: who.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await db.insert(account).values({
    id: randomUUID(),
    accountId: randomUUID(),
    providerId: "microsoft",
    userId: who.id,
  });
  const reset = await send("reset-password", { ...body, token: resetToken });
  expect(await reset.json()).toEqual({
    code: "INVALID_TOKEN",
    message: "Invalid token",
  });
  const change = await send(
    "change-password",
    { ...body, currentPassword: password },
    who.cookie,
  );
  expect(change.status).toBe(400);
  expect(await change.json()).toMatchObject({
    message: "Use your existing sign-in provider.",
  });
  const other = await passwordPerson();
  const before = mock.outbox.length;
  await send("email/forgot-password", { email: other.email });
  await vi.waitFor(() => {
    expect(mock.outbox.length).toBe(before + 1);
  });
  const spent = token();
  const changed = await send("reset-password", { ...body, token: spent });
  expect(changed.status).toBe(200);
  const refused = await send("reset-password", {
    token: spent,
    newPassword: password,
  });
  expect(refused.status).toBe(400);
  const unknown = await send("reset-password", {
    token: "made-up",
    newPassword: password,
  });
  expect(await refused.json()).toEqual(await unknown.json());
});

it("gives a deleted user's reset token the same refusal as a made-up token", async () => {
  const resetToken = randomUUID();
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: createHash("sha256")
      .update(`reset-password:${resetToken}`)
      .digest("base64url"),
    value: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const orphan = await send("reset-password", {
    token: resetToken,
    newPassword: password,
  });
  const unknown = await send("reset-password", {
    token: "made-up",
    newPassword: password,
  });
  expect(orphan.status).toBe(400);
  expect(await orphan.clone().json()).toEqual({
    code: "INVALID_TOKEN",
    message: "Invalid token",
  });
  expect(await orphan.json()).toEqual(await unknown.json());
});

it("treats a malformed encoded path as an unknown auth path", async () => {
  const auth = createAuth(f.deps);
  const request = new Request("https://metrics.example.com/api/auth/%E0");
  expect((await auth.handle(request, null)).status).toBe(404);
});

it("rolls back acceptance when a provider account appears during the user upsert", async () => {
  const who = await f.person();
  await db
    .update(user)
    .set({ email: "race@sample.example", emailVerified: false })
    .where(eq(user.id, who.id));
  const pending = await opened("race@sample.example");
  await testPool("migrator")
    .query(`create function accept_provider_race() returns trigger language plpgsql as $$ begin
    insert into account (id, account_id, provider_id, user_id, created_at, updated_at) values (gen_random_uuid()::text, gen_random_uuid()::text, 'microsoft', new.id, now(), now()); return new;
    end $$;
    create trigger accept_provider_race after update of email_verified on "user" for each row when (new.email = 'race@sample.example') execute function accept_provider_race()`);
  try {
    const refused = await send("invites/accept", {
      token: pending,
      password,
    });
    expect(refused.status).toBe(400);
    const unknown = await send("invites/accept", {
      token: UNKNOWN,
      password,
    });
    expect(await refused.json()).toEqual(await unknown.json());
    const [row] = await db.select().from(user).where(eq(user.id, who.id));
    expect(row?.emailVerified).toBe(false);
    expect(
      await db.select().from(account).where(eq(account.userId, who.id)),
    ).toEqual([]);
  } finally {
    await testPool("migrator").query(
      'drop trigger accept_provider_race on "user"; drop function accept_provider_race()',
    );
  }
});

it("offers no password through an invite when password sign-in is off", async () => {
  await settings.set("sign_in.email_password", false);
  // An app made now builds its auth from the settings as they are; the
  // fixture's may still be cached, since an earlier test moved the clock back.
  const rebuilt = createApp(f.deps);
  const send = (path: string, body: object) =>
    rebuilt.request(path, fromSpa("", body), {
      incoming: { socket: { remoteAddress: freshPeer() } },
    });
  expect((await invite(`${randomUUID()}@sample.example`)).status).toBe(200);
  const value = token();
  const looked = await send("/api/auth/invites/lookup", { token: value });
  expect(await looked.json()).toMatchObject({
    state: "open",
    password_allowed: false,
  });
  expect(
    (await send("/api/auth/invites/accept", { token: value, password })).status,
  ).toBe(403);
});
