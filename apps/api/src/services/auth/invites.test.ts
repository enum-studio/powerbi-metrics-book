import { randomUUID } from "node:crypto";
import {
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  adminOnRecord,
  cerbosAccess,
  closeTestPools,
  createTestDeps,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { newIdentity } from "../../../test/secrets-support.js";
import type { ServiceContext } from "../../context.js";
import { auditEvent } from "../../db/schema/audit.js";
import { user } from "../../db/schema/auth.js";
import { brandLogo } from "../../db/schema/branding.js";
import { invite } from "../../db/schema/invites.js";
import { personDeactivation } from "../../db/schema/people.js";
import { requestRate } from "../../db/schema/rate-limit.js";
import { createGuardedFetcher } from "../../http/fetcher.js";
import { createSecretReader } from "../secrets/store.js";
import { emailReady, sendPasswordLink } from "./email.js";
import {
  invitePeople,
  listInvites,
  lookupInvite,
  resendInvite,
  revokeInvite,
} from "./invites.js";

const settings = new MemorySettings();
const secrets = new MemorySecrets();
let now = new Date("2030-03-04T12:00:00Z");
const mock = await startMockPowerBi({ tenant: sampleTenant() });
const deps = createTestDeps({
  settings,
  secrets,
  clock: () => now,
  access: cerbosAccess(settings),
  fetcher: createGuardedFetcher({
    nodeEnv: "test",
    allowedOrigins: () => Promise.resolve([mock.url]),
  }),
});
const admin: ServiceContext = {
  ...deps,
  principal: await adminOnRecord(deps, { name: "Sample <Admin>" }),
};
const adminId = admin.principal.id;
const mailbox = () => `${randomUUID()}@sample.example`;
const tokenOf = (link: string | null | undefined) =>
  new URLSearchParams(new URL(String(link)).hash.slice(1)).get("token") ?? "";
const byLink = async (email: string, role = "viewer") =>
  (await invitePeople(admin, { emails: [email], role, delivery: "link" }))
    .invites[0];

beforeAll(async () => {
  await settings.set("email.base_url", mock.url);
  await settings.set("email.from", "invites@sample.example");
  await secrets.write("resend_api_key", "sample-resend-key");
});
afterAll(async () => {
  await mock.close();
  await closeTestPools();
});

it("emails the invite in the brand, every value escaped", async () => {
  await settings.set("branding.name", 'Sample & "Co"');
  await deps.db.insert(brandLogo).values({
    content_type: "image/png",
    bytes: new Uint8Array([1]),
    sha256: "ab".repeat(32),
  });
  const email = mailbox();
  const { invites } = await invitePeople(admin, {
    emails: [email.toUpperCase()],
    role: "admin",
    delivery: "email",
  });
  expect(invites).toEqual([expect.objectContaining({ email, link: null })]);
  const sent = mock.outbox.at(-1);
  expect(sent?.subject).toBe('Sample <Admin> invited you to Sample & "Co"');
  expect(sent?.text).toContain(
    'Sample <Admin> invited you to Sample & "Co" as an Admin. Sample & "Co" lets your AI agent look up what your Power BI numbers mean and query them with your own Power BI rights.',
  );
  expect(sent?.text).toContain("This invite expires on 11 March 2030.");
  expect(sent?.text).toContain(
    "If you did not expect it, you can ignore this email.",
  );
  const link = sent?.text.split("\n").at(-1);
  expect(link).toMatch(/^https:\/\/metrics\.example\.com\/invite#token=/);
  expect(sent?.html).toContain(
    `<img src="https://metrics.example.com/api/branding/logo?v=${"ab".repeat(6)}" alt="Sample &amp; &quot;Co&quot;">`,
  );
  expect(sent?.html).toContain("Sample &lt;Admin&gt; invited you");
  expect(sent?.html).toContain(`>Accept invite</a>`);
  await sendPasswordLink(deps, email, "sample");
  expect(mock.outbox.at(-1)?.text).toContain('for Sample & "Co".');
  await deps.db.delete(brandLogo);
  await settings.set("branding.name", null);
  expect(await lookupInvite(deps, tokenOf(link))).toEqual({
    state: "open",
    email,
    role: "admin",
    inviter_name: "Sample <Admin>",
    expires_at: new Date("2030-03-11T12:00:00Z"),
    password_allowed: false,
  });
  await settings.set("sign_in.email_password", true);
  expect(await lookupInvite(deps, tokenOf(link))).toMatchObject({
    password_allowed: true,
  });
  await settings.set("sign_in.email_password", false);
});

it("sends an open invite again with the new role, and lists it until it expires", async () => {
  const email = mailbox();
  const first = await byLink(email);
  now = new Date(now.getTime() + 3600_000);
  const again = await byLink(email, "curator");
  expect(again?.id).toBe(first?.id);
  expect(await lookupInvite(deps, tokenOf(first?.link))).toEqual({
    state: "invalid",
  });
  const listed = (await listInvites(admin)).find((i) => i.email === email);
  expect(listed).toEqual({
    id: first?.id,
    email,
    role: "curator",
    delivery: "link",
    inviter_name: "Sample <Admin>",
    last_sent_at: now,
    expires_at: new Date(now.getTime() + 7 * 86400_000),
    expired: false,
  });
  now = new Date(now.getTime() + 7 * 86400_000);
  expect(
    (await listInvites(admin)).find((i) => i.email === email)?.expired,
  ).toBe(true);
  expect(await lookupInvite(deps, tokenOf(again?.link))).toEqual({
    state: "expired",
    inviter_name: "Sample <Admin>",
    expires_at: now,
  });
});

it("resends at most once a minute and 10 times a day, and revokes", async () => {
  const made = await byLink(mailbox());
  const id = String(made?.id);
  const links = new Set([made?.link]);
  for (let i = 0; i < 10; i++) {
    now = new Date(now.getTime() + 61_000);
    const previous = [...links].at(-1);
    const resent = await resendInvite(admin, id);
    expect(resent.expires_at).toEqual(new Date(now.getTime() + 7 * 86400_000));
    expect(await lookupInvite(deps, tokenOf(previous))).toEqual({
      state: "invalid",
    });
    links.add(resent.link);
    await expect(resendInvite(admin, id)).rejects.toMatchObject({
      kind: "rate_limited",
    });
  }
  now = new Date(now.getTime() + 61_000);
  await expect(resendInvite(admin, id)).rejects.toMatchObject({
    kind: "rate_limited",
  });
  expect(links.size).toBe(11);
  await revokeInvite(admin, id);
  expect(await lookupInvite(deps, tokenOf([...links].at(-1)))).toEqual({
    state: "invalid",
  });
  expect((await listInvites(admin)).some((i) => i.id === id)).toBe(false);
  await expect(revokeInvite(admin, id)).rejects.toMatchObject({
    kind: "not_found",
  });
  await expect(resendInvite(admin, "not-an-id")).rejects.toMatchObject({
    kind: "not_found",
  });
});

it("sends an open invite again by inviting at most once a minute and 10 times a day", async () => {
  const email = mailbox();
  const made = await byLink(email);
  await expect(resendInvite(admin, String(made?.id))).resolves.toBeDefined();
  const again = byLink(email, "curator");
  await expect(again).rejects.toMatchObject({ kind: "rate_limited" });
  await expect(again).rejects.toThrow(
    "This invite was sent too often. Try again in ",
  );
  for (let i = 0; i < 9; i++) {
    now = new Date(now.getTime() + 61_000);
    expect((await byLink(email))?.id).toBe(made?.id);
  }
  now = new Date(now.getTime() + 61_000);
  await expect(byLink(email)).rejects.toMatchObject({ kind: "rate_limited" });
  await expect(resendInvite(admin, String(made?.id))).rejects.toMatchObject({
    kind: "rate_limited",
  });
});

it("counts each emailed invite against its admin's 200 a day, and no link", async () => {
  const other = { ...admin, principal: await adminOnRecord(deps) };
  const id = other.principal.id;
  const day = 86400_000;
  await deps.db.insert(requestRate).values({
    key: `invite_email:${id}`,
    window_start: new Date(Math.floor(now.getTime() / day) * day),
    count: 198,
  });
  const emailed = (emails: string[]) =>
    invitePeople(other, { emails, role: "viewer", delivery: "email" });
  const resets = new Date((Math.floor(now.getTime() / day) + 1) * day);
  const pair = [mailbox(), mailbox()];
  await expect(emailed([...pair, mailbox()])).rejects.toMatchObject({
    kind: "rate_limited",
    message: `You can email 200 invites a day. The count resets at ${resets.toISOString().slice(0, 16).replace("T", " ")} UTC; until then, invite by link.`,
  });
  await expect(emailed(pair)).resolves.toBeDefined();
  await expect(emailed([mailbox()])).rejects.toMatchObject({
    kind: "rate_limited",
  });
  await expect(
    invitePeople(other, {
      emails: [mailbox()],
      role: "viewer",
      delivery: "link",
    }),
  ).resolves.toBeDefined();
  now = resets;
  await expect(emailed([mailbox()])).resolves.toBeDefined();
});

it("names the admin who invited an open invite again as its inviter", async () => {
  const email = mailbox();
  await byLink(email);
  now = new Date(now.getTime() + 61_000);
  const second = await adminOnRecord(deps);
  const { id } = second;
  await invitePeople(
    { ...admin, principal: second },
    { emails: [email], role: "viewer", delivery: "link" },
  );
  const [row] = await deps.db
    .select({ invited_by: invite.invited_by })
    .from(invite)
    .where(eq(invite.email, email));
  expect(row?.invited_by).toBe(id);
});

it("counts a resent emailed invite against its admin's 200 a day, and sends nothing past it", async () => {
  const other = { ...admin, principal: await adminOnRecord(deps) };
  const id = other.principal.id;
  const day = 86400_000;
  await deps.db.insert(requestRate).values({
    key: `invite_email:${id}`,
    window_start: new Date(Math.floor(now.getTime() / day) * day),
    count: 199,
  });
  const email = mailbox();
  await invitePeople(other, {
    emails: [email],
    role: "viewer",
    delivery: "email",
  });
  const token = tokenOf(mock.outbox.at(-1)?.text.split("\n").at(-1));
  const sent = mock.outbox.length;
  const made = (await listInvites(other)).find((i) => i.email === email);
  now = new Date(now.getTime() + 61_000);
  await expect(resendInvite(other, String(made?.id))).rejects.toThrow(
    "You can email 200 invites a day.",
  );
  expect(mock.outbox.length).toBe(sent);
  expect(await lookupInvite(deps, token)).toMatchObject({ state: "open" });
});

it("refuses a bad batch, PII, an unshipped role, email without its setup and a deactivated person", async () => {
  const email = mailbox();
  const refused = (
    input: Partial<Parameters<typeof invitePeople>[1]>,
    sentence: string,
    context = admin,
  ) =>
    expect(
      invitePeople(context, {
        emails: [email],
        role: "viewer",
        delivery: "link",
        ...input,
      }),
    ).rejects.toThrow(sentence);
  await refused({ emails: [] }, "Invite 1 to 50 emails at a time.");
  await refused(
    { emails: Array.from({ length: 51 }, mailbox) },
    "Invite 1 to 50 emails at a time.",
  );
  await refused(
    { role: "pii_reader" },
    "Give PII on the person once they have joined.",
  );
  await refused({ role: "auditor" }, "auditor is not a shipped role");
  await refused(
    { role: "Auditor", custom: true },
    "Auditor is not a role name",
  );
  await refused(
    { emails: ["not-an-email"] },
    "not-an-email is not an email address.",
  );
  await refused({ delivery: "email" }, "Set resend_api_key", {
    ...admin,
    secrets: new MemorySecrets(),
  });
  const gone = { id: randomUUID(), email: mailbox(), name: "Gone" };
  await deps.db.insert(user).values(gone);
  await deps.db
    .insert(personDeactivation)
    .values({ user_id: gone.id, deactivated_by: adminId });
  await refused({ emails: [gone.email] }, `Reactivate ${gone.email} instead.`);
  const custom = await invitePeople(admin, {
    emails: [email, email.toUpperCase()],
    role: "auditor",
    custom: true,
    delivery: "link",
  });
  expect(custom.invites).toHaveLength(1);
  expect(
    await deps.db.select().from(user).where(eq(user.email, email)),
  ).toEqual([]);
});

it("says email works with the Resend key from the environment, and not without a key or a sender", async () => {
  const fromEnvironment = createSecretReader(
    {
      container: "api",
      db: deps.db,
      env: { RESEND_API_KEY: "sample-resend-key-from-environment" },
    },
    await newIdentity(),
  );
  await expect(
    emailReady({ ...admin, secrets: fromEnvironment }),
  ).resolves.toBe(true);
  await expect(
    emailReady({ ...admin, secrets: new MemorySecrets() }),
  ).resolves.toBe(false);
  await expect(
    emailReady({ ...admin, settings: new MemorySettings() }),
  ).resolves.toBe(false);
});

it("records every invite it saved before it emails any, so a failed email leaves none unrecorded", async () => {
  let sends = 0;
  const failing: ServiceContext = {
    ...admin,
    fetcher: {
      ...admin.fetcher,
      fetchFixed: (url, init) => {
        sends += 1;
        return sends === 2
          ? Promise.resolve(new Response("down", { status: 500 }))
          : admin.fetcher.fetchFixed(url, init);
      },
    },
  };
  const emails = [mailbox(), mailbox(), mailbox()];
  await expect(
    invitePeople(failing, { emails, role: "viewer", delivery: "email" }),
  ).rejects.toMatchObject({ kind: "upstream" });
  const recorded = await admin.db
    .select({ email: auditEvent.resource_id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, "admin.people.invite"),
        inArray(auditEvent.resource_id, emails),
      ),
    );
  expect(recorded.map((row) => row.email).sort()).toEqual([...emails].sort());
});
