import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { MemorySettings } from "../../../test/doubles.js";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  testConfig,
} from "../../../test/deps.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { assignRole } from "../../services/auth/roles.js";
import {
  createKey,
  createServiceAccount,
} from "../../services/auth/service-accounts.js";

afterAll(closeTestPools);

describe("GET /api/v1/me sample_data", () => {
  const settings = new MemorySettings();
  const oauth = startOAuth({ settings });

  async function sampleData(authority?: string): Promise<unknown> {
    if (authority !== undefined)
      await settings.set("powerbi.authority", authority);
    const { cookie } = await oauth.person();
    const answer = await oauth.request("/api/v1/me", { headers: { cookie } });
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { sample_data: unknown }).sample_data;
  }

  it("is false on Microsoft's public cloud, which is the default", async () => {
    expect(await sampleData()).toBe(false);
  });

  it.each([
    "http://powerbi-mock.localhost:30001",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ])("is true when the authority is the mock at %s", async (authority) => {
    expect(await sampleData(authority)).toBe(true);
  });

  it.each([
    "https://login.microsoftonline.com",
    "https://login.microsoftonline.us",
    "https://login.chinacloudapi.cn",
    "http://127.0.0.2:3001",
    "https://localhost.example.com",
    "https://login.localhost.example.com",
  ])("is false for a real cloud's authority, %s", async (authority) => {
    expect(await sampleData(authority)).toBe(false);
  });
});

describe("GET /api/v1/me may_admin", () => {
  const settings = new MemorySettings();
  const oauth = startOAuth({ settings, access: cerbosAccess(settings) });
  const mayAdmin = async (cookie: string) =>
    (
      (await (
        await oauth.request("/api/v1/me", { headers: { cookie } })
      ).json()) as {
        may_admin: unknown;
      }
    ).may_admin;

  it("is false for a viewer and true for an admin, as the admin section's own guard decides", async () => {
    const viewer = await oauth.person();
    expect(await mayAdmin(viewer.cookie)).toBe(false);
    const admin = await oauth.person();
    await assignRole(
      oauth.deps.db,
      { role: "admin", subject_kind: "person", subject: admin.email },
      principals.admin,
    );
    expect(await mayAdmin(admin.cookie)).toBe(true);
  });
});

describe("GET /api/v1/me client_address", () => {
  const addressOn = async (
    oauth: ReturnType<typeof startOAuth>,
  ): Promise<unknown> => {
    const { cookie } = await oauth.person();
    const answer = await oauth.request("/api/v1/me", {
      headers: { cookie, "x-real-ip": "192.0.2.1" },
    });
    return ((await answer.json()) as { client_address: unknown })
      .client_address;
  };

  it("is the connection's address by default, which ignores X-Real-IP", async () => {
    const address = await addressOn(startOAuth());
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(address).not.toBe("192.0.2.1");
  });

  it("is the X-Real-IP address under CLIENT_ADDRESS_HEADER=x-real-ip", async () => {
    const config = testConfig("api", {
      ALLOW_DEV_SIGN_IN: "1",
      CLIENT_ADDRESS_HEADER: "x-real-ip",
    });
    expect(await addressOn(startOAuth({ config }))).toBe("192.0.2.1");
  });
});

describe("GET /api/v1/me/connection", () => {
  const oauth = startOAuth();

  it("says not_connected for a person who never connected", async () => {
    const { cookie } = await oauth.person();
    const answer = await oauth.request("/api/v1/me/connection", {
      headers: { cookie },
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      status: "not_connected",
      account: null,
      connected_at: null,
      last_used_at: null,
      reason: null,
    });
  });

  it("names the account, its last use and why it needs a reconnect, and no token", async () => {
    const { id, cookie } = await oauth.person();
    const connected_at = new Date("2026-10-01T08:00:00Z");
    const last_used_at = new Date("2026-10-20T09:30:00Z");
    await oauth.deps.db.insert(powerbiConnection).values({
      user_id: id,
      microsoft_object_id: randomUUID(),
      user_principal_name: "someone@sample.example",
      status: "needs_reconnect",
      connected_at,
      last_used_at,
      last_error: "Your Power BI connection expired. Reconnect it.",
    });
    const answer = await oauth.request("/api/v1/me/connection", {
      headers: { cookie },
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      status: "needs_reconnect",
      account: "someone@sample.example",
      connected_at: connected_at.toISOString(),
      last_used_at: last_used_at.toISOString(),
      reason: "Your Power BI connection expired. Reconnect it.",
    });
  });

  it("answers 401 without a credential", async () => {
    expect((await oauth.request("/api/v1/me/connection")).status).toBe(401);
  });
});

describe("GET /api/v1/me names the caller on every credential", () => {
  const settings = new MemorySettings();
  const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

  it("gives a CLI token's person their email and name", async () => {
    const { id, email, cookie } = await oauth.person();
    await oauth.deps.db
      .update(user)
      .set({ name: "Ada Lovelace" })
      .where(eq(user.id, id));
    const { access_token } = await oauth.login(cookie);
    const answer = await oauth.bearer("/api/v1/me", access_token);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      id,
      kind: "person",
      via: "cli",
      email,
      name: "Ada Lovelace",
      sign_in_method: null,
    });
  });

  it("gives a service account no email, whoever shares its name", async () => {
    const { email } = await oauth.person();
    const name = `reader_${randomUUID().slice(0, 8)}`;
    const admin = { ...oauth.deps, principal: principals.admin };
    await createServiceAccount(admin, {
      name,
      owner_email: email,
      roles: ["viewer"],
    });
    const { key } = await createKey(admin, name, { expires_in_days: 7 });
    const answer = await oauth.bearer("/api/v1/me", key);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      id: name,
      kind: "service_account",
      email: null,
    });
  });
});

describe("GET /api/v1/me usage", () => {
  const settings = new MemorySettings();
  const oauth = startOAuth({ settings });

  it("answers the defaults and follows changes to capture and retention", async () => {
    const { cookie } = await oauth.person();
    const usage = async () => {
      const answer = await oauth.request("/api/v1/me", { headers: { cookie } });
      expect(answer.status).toBe(200);
      return ((await answer.json()) as { usage: unknown }).usage;
    };
    expect(await usage()).toEqual({ capture: true, retention_days: 180 });
    await settings.set("usage.capture", false);
    await settings.set("usage.retention_days", 30);
    expect(await usage()).toEqual({ capture: false, retention_days: 30 });
  });
});
