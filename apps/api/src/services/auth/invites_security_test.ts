import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { roleUrl } from "../../../test/database.js";
import {
  cerbosAccess,
  closeTestPools,
  principals,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import {
  freshPeer,
  fromSpa,
  startOAuth,
} from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import type { ServiceContext } from "../../context.js";
import { migrateDatabase } from "../../db/migrate.js";
import { user } from "../../db/schema/auth.js";
import { invite } from "../../db/schema/invites.js";
import { personDeactivation } from "../../db/schema/people.js";
import { roleAssignment } from "../../db/schema/roles.js";
import { createGuardedFetcher } from "../../http/fetcher.js";
import { buildAuth, readInputs } from "./better-auth.js";
import { invitePeople, listInvites, revokeInvite } from "./invites.js";
import { assignRole, roleSubject } from "./roles.js";

const settings = new MemorySettings();
const secrets = new MemorySecrets();
const now = new Date();
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
const app = createApp(f.deps);
const db = f.deps.db;
let admin: ServiceContext;
const mailbox = () => `${randomUUID()}@sample.example`;
const request = (path: string, body: object, peer = freshPeer()) =>
  app.request(path, fromSpa("", body), {
    incoming: { socket: { remoteAddress: peer } },
  });
const accept = (token: string) =>
  request("/api/auth/invites/accept", {
    token,
    password: "sample-password-12345",
  });
const lookup = (token: string, peer?: string) =>
  request("/api/auth/invites/lookup", { token }, peer);
/** A token as every invite's is shaped, that names no invite. */
const UNKNOWN = "A".repeat(43);
const tokenOf = (link: string | null | undefined) =>
  new URLSearchParams(new URL(String(link)).hash.slice(1)).get("token") ?? "";
const mailed = async (email = mailbox()) => {
  await invitePeople(admin, {
    emails: [email],
    role: "viewer",
    delivery: "email",
  });
  return tokenOf(mock.outbox.at(-1)?.text.split("\n").at(-1));
};

beforeAll(async () => {
  const person = await f.person();
  await assignRole(
    db,
    { role: "admin", subject_kind: "person", subject: person.email },
    principals.admin,
  );
  admin = { ...f.deps, principal: { ...principals.admin, id: person.id } };
  await settings.set("email.base_url", mock.url);
  await settings.set("email.from", "invites@sample.example");
  await secrets.write("resend_api_key", "sample-resend-key");
  await settings.set("sign_in.email_password", true);
});
afterAll(async () => {
  await mock.close();
  await closeTestPools();
});

it("gives a link invite no role and no password, and mails no token", async () => {
  const email = mailbox();
  const sent = mock.outbox.length;
  const { invites } = await invitePeople(admin, {
    emails: [email],
    role: "curator",
    delivery: "link",
  });
  const token = tokenOf(invites[0]?.link);
  expect(invites[0]?.link).toBe(
    `https://metrics.example.com/invite#token=${token}`,
  );
  expect(mock.outbox.length).toBe(sent);
  expect(JSON.stringify(mock.outbox)).not.toContain(token);
  const [row] = await db
    .select({ token_sha256: invite.token_sha256 })
    .from(invite)
    .where(eq(invite.email, email));
  expect(row?.token_sha256).toBe(
    createHash("sha256").update(token).digest("hex"),
  );
  const assigned = db.select().from(roleAssignment);
  expect(await assigned.where(eq(roleAssignment.subject, email))).toEqual([]);
  const refused = await accept(token);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual(await (await accept(UNKNOWN)).json());
  expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
});

it("answers revoked, accepted and unknown tokens alike, and accepts no expired or revoked one", async () => {
  const revoked = mailbox();
  const revokedToken = await mailed(revoked);
  const id = (await listInvites(admin)).find((i) => i.email === revoked)?.id;
  await revokeInvite(admin, String(id));
  const acceptedToken = await mailed();
  expect((await accept(acceptedToken)).status).toBe(200);
  const expired = mailbox();
  const expiredToken = await mailed(expired);
  await db
    .update(invite)
    .set({ expires_at: new Date(now.getTime() - 1000) })
    .where(eq(invite.email, expired));
  const answers = [];
  for (const token of [revokedToken, acceptedToken, UNKNOWN]) {
    const answer = await lookup(token);
    answers.push({ status: answer.status, body: await answer.json() });
  }
  expect(answers).toEqual(
    Array(3).fill({ status: 200, body: { state: "invalid" } }),
  );
  expect(await (await lookup(expiredToken)).json()).toMatchObject({
    state: "expired",
  });
  for (const token of [revokedToken, expiredToken]) {
    const refused = await accept(token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "INVALID_TOKEN" });
  }
});

it("looks up an open invite with password sign-in off", async () => {
  const token = await mailed();
  await settings.set("sign_in.email_password", false);
  try {
    // A new app builds its auth from the settings as they are now.
    const answer = await createApp(f.deps).request(
      "/api/auth/invites/lookup",
      fromSpa("", { token }),
      { incoming: { socket: { remoteAddress: freshPeer() } } },
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      state: "open",
      password_allowed: false,
    });
  } finally {
    await settings.set("sign_in.email_password", true);
  }
});

it("refuses a token in the query string at lookup", async () => {
  const token = await mailed();
  const path = `/api/auth/invites/lookup?token=${token}`;
  expect((await request(path, {})).status).toBe(400);
  expect((await request(path, { token })).status).toBe(400);
});

it("refuses the 21st lookup in a minute from one address", async () => {
  const peer = "2001:db8::21";
  for (let i = 0; i < 20; i++)
    expect((await lookup("unknown", peer)).status).toBe(200);
  expect((await lookup("unknown", peer)).status).toBe(429);
  expect((await lookup("unknown")).status).toBe(200);
});

it("refuses the 4th accept in 10 seconds from one address before its handler hashes the password", async () => {
  const token = await mailed();
  const peer = "2001:db8::4";
  for (let i = 0; i < 3; i++)
    expect(
      (
        await request(
          "/api/auth/invites/accept",
          { token: "unknown", password: "sample-password-12345" },
          peer,
        )
      ).status,
    ).toBe(400);
  const limited = await request(
    "/api/auth/invites/accept",
    { token, password: "sample-password-12345" },
    peer,
  );
  expect(limited.status).toBe(429);
  expect(await (await lookup(token)).json()).toMatchObject({ state: "open" });
});

it("hashes no password for a token that names no open, emailed invite", async () => {
  const { instance } = await buildAuth(f.deps, await readInputs(f.deps));
  const hash = vi.spyOn((await instance.$context).password, "hash");
  const send = (token: string) =>
    instance.handler(
      new Request(
        "https://metrics.example.com/api/auth/invites/accept",
        fromSpa("", { token, password: "sample-password-12345" }),
      ),
    );
  const { invites } = await invitePeople(admin, {
    emails: [mailbox()],
    role: "viewer",
    delivery: "link",
  });
  for (const token of [UNKNOWN, tokenOf(invites[0]?.link)]) {
    const refused = await send(token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "INVALID_TOKEN" });
  }
  expect(hash).not.toHaveBeenCalled();
  expect((await send(await mailed())).status).toBe(200);
  expect(hash).toHaveBeenCalledTimes(1);
});

it("refuses to invite an active user, and a non-admin or service account to invite", async () => {
  const person = await f.person();
  await expect(
    invitePeople(admin, {
      emails: [person.email],
      role: "curator",
      delivery: "link",
    }),
  ).rejects.toThrow(
    `${person.email} is already a user. Change their role instead.`,
  );
  const email = mailbox();
  for (const principal of [
    principals.viewer,
    principals.curator,
    { ...principals.admin, kind: "service_account" as const },
  ])
    await expect(
      invitePeople(
        { ...f.deps, principal },
        { emails: [email], role: "admin", delivery: "link" },
      ),
    ).rejects.toMatchObject({ kind: "refused" });
  expect(
    await db
      .select({ id: invite.id })
      .from(invite)
      .where(eq(invite.email, email)),
  ).toEqual([]);
});

it("keeps a revoked invite ended through a start, which runs upgrade_invites.sql", async () => {
  const email = mailbox();
  const token = await mailed(email);
  const sent = (await listInvites(admin)).find((i) => i.email === email);
  if (sent === undefined) throw new Error("the invite above is open");
  await revokeInvite(admin, sent.id);
  await migrateDatabase(roleUrl("migrator"));
  expect(await (await lookup(token)).json()).toEqual({ state: "invalid" });
  const refused = await accept(token);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "INVALID_TOKEN" });
  expect((await listInvites(admin)).some((i) => i.email === email)).toBe(false);
  // Nor does it give its role to a verified sign-in of its email.
  const signing = { id: null, email, email_verified: true };
  expect(await roleSubject(db, signing, now)).toMatchObject({
    open_invite_role: null,
  });
});

it("keeps an invite made before 0003 ended through a start, revoked or accepted", async () => {
  // The rows upgrade_invites.sql reads: last_sent_at null, as 0003 left them.
  const tokens = new Map<string, string>();
  const before = (email: string, ended: object) => {
    const token = randomBytes(32).toString("base64url");
    tokens.set(email, token);
    return {
      email,
      role: "viewer",
      token_sha256: createHash("sha256").update(token).digest("hex"),
      invited_by: admin.principal.id,
      expires_at: new Date(Date.now() + 3600_000),
      last_sent_at: null,
      ...ended,
    };
  };
  const revoked = mailbox();
  const accepted = mailbox();
  await db
    .insert(invite)
    .values([
      before(revoked, { revoked_at: new Date(), revoked_by: "admin" }),
      before(accepted, { accepted_at: new Date() }),
    ]);
  await migrateDatabase(roleUrl("migrator"));
  for (const email of [revoked, accepted]) {
    const token = String(tokens.get(email));
    expect(await (await lookup(token)).json()).toEqual({ state: "invalid" });
    const refused = await accept(token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "INVALID_TOKEN" });
    const signing = { id: null, email, email_verified: true };
    expect(await roleSubject(db, signing, now)).toMatchObject({
      open_invite_role: null,
    });
  }
  const listed = (await listInvites(admin)).map((i) => i.email);
  expect(listed).not.toContain(revoked);
  expect(listed).not.toContain(accepted);
});

it("refuses an invite from an admin deactivated after their request passed the role check", async () => {
  const inviter = await f.person();
  const context = {
    ...f.deps,
    principal: { ...principals.admin, id: inviter.id },
  };
  await db
    .insert(personDeactivation)
    .values({ user_id: inviter.id, deactivated_by: principals.admin.id });
  const email = mailbox();
  await expect(
    invitePeople(context, { emails: [email], role: "admin", delivery: "link" }),
  ).rejects.toMatchObject({ kind: "refused" });
  expect(
    await db
      .select({ id: invite.id })
      .from(invite)
      .where(eq(invite.email, email)),
  ).toEqual([]);
});

it("answers a token no invite could have as invalid, and refuses it at accept before the handler", async () => {
  for (const token of ["x".repeat(10_000), "a".repeat(42), "%".repeat(43)]) {
    expect(await (await lookup(token)).json()).toEqual({ state: "invalid" });
    const refused = await accept(token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).not.toMatchObject({ code: "INVALID_TOKEN" });
  }
});
