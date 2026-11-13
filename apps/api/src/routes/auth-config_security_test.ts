import { afterAll, describe, expect, it, vi } from "vitest";
import * as people from "../services/admin/people.js";
import { MemorySecrets, MemorySettings } from "../../test/doubles.js";
import { closeTestPools, createTestDeps, testConfig } from "../../test/deps.js";
import { createApp } from "../app.js";
import type { SettingKey, SettingValue } from "../context.js";

afterAll(closeTestPools);

/** Counts how often the passkey setting is read: once per read of the whole config. */
class CountingSettings extends MemorySettings {
  passkeyReads = 0;

  override get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    if (key === "sign_in.passkeys") this.passkeyReads += 1;
    return super.get(key);
  }
}

const APP_CLIENT_ID = "c1000000-0000-4000-8000-000000000002";
const GOOGLE_CLIENT_ID = "sample-google.apps.example";
const ISSUER = "https://id.sample.example";

/** The sample tenant's sign-in: Microsoft, Google with its secret, and an OpenID Connect provider whose secret is not set yet. */
function sampleApp(env: Record<string, string> = {}) {
  return createApp(
    createTestDeps({
      config: testConfig("api", env),
      settings: new MemorySettings({
        "powerbi.tenant_id": "11111111-1111-4111-8111-111111111111",
        "powerbi.app_client_id": APP_CLIENT_ID,
        "sign_in.passkeys": true,
        "access.default_role": "none",
        "sign_in.providers": [
          {
            id: "google",
            kind: "google",
            label: "Google",
            client_id: GOOGLE_CLIENT_ID,
            issuer: null,
          },
          {
            id: "sample_okta",
            kind: "oidc",
            label: "Sample Okta",
            client_id: "sample-okta-client",
            issuer: ISSUER,
          },
        ],
      }),
      secrets: new MemorySecrets([
        ["powerbi_app_client_secret", "sample-app-secret"],
        ["sign_in_google_client_secret", "sample-google-secret"],
      ]),
    }),
  );
}

describe("GET /api/auth/config", () => {
  it("answers without a credential, naming the providers that can sign in now", async () => {
    const answer = await sampleApp().request("/api/auth/config");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      providers: [
        { id: "microsoft", kind: "microsoft", name: "Microsoft" },
        { id: "google", kind: "google", name: "Google" },
      ],
      passkeys: true,
      email_password: false,
      dev_sign_in: false,
      sample_data: false,
      demo: false,
      setup_pending: true,
      brand: {
        name: "Power BI Metrics Book",
        company: null,
        logo_url: null,
        custom: false,
      },
      invite_only: true,
    });
  });

  it("says whether the stack runs on the mock tenant, from the authority alone", async () => {
    const settings = new MemorySettings({
      "powerbi.authority": "http://powerbi-mock.localhost:30001",
    });
    const answer = await createApp(createTestDeps({ settings })).request(
      "/api/auth/config",
    );
    expect(await answer.json()).toMatchObject({ sample_data: true });
  });

  it("holds no client id, issuer, secret or redirect URI", async () => {
    const answer = await sampleApp().request("/api/auth/config");
    const text = await answer.text();
    const body = JSON.parse(text) as { providers: object[]; brand: object };
    expect(Object.keys(body).sort()).toEqual([
      "brand",
      "demo",
      "dev_sign_in",
      "email_password",
      "invite_only",
      "passkeys",
      "providers",
      "sample_data",
      "setup_pending",
    ]);
    expect(Object.keys(body.brand).sort()).toEqual([
      "company",
      "custom",
      "logo_url",
      "name",
    ]);
    for (const provider of body.providers)
      expect(Object.keys(provider).sort()).toEqual(["id", "kind", "name"]);
    for (const value of [
      APP_CLIENT_ID,
      GOOGLE_CLIENT_ID,
      ISSUER,
      "sample-app-secret",
      "sample-google-secret",
      "callback",
    ])
      expect(text).not.toContain(value);
  });

  it("offers the dev sign-in only when its route is open", async () => {
    const open = await sampleApp({ ALLOW_DEV_SIGN_IN: "1" }).request(
      "/api/auth/config",
    );
    expect(await open.json()).toMatchObject({ dev_sign_in: true });
    const production = await sampleApp({
      ALLOW_DEV_SIGN_IN: "1",
      NODE_ENV: "production",
    }).request("/api/auth/config");
    expect(await production.json()).toMatchObject({ dev_sign_in: false });
  });

  it("reads the settings again after 30 seconds, as Better Auth does", async () => {
    let now = Date.parse("2026-10-26T12:00:00Z");
    const settings = new MemorySettings();
    const app = createApp(
      createTestDeps({ settings, clock: () => new Date(now) }),
    );
    const passkeys = async () =>
      (
        (await (await app.request("/api/auth/config")).json()) as {
          passkeys: boolean;
        }
      ).passkeys;
    expect(await passkeys()).toBe(false);
    await settings.set("sign_in.passkeys", true);
    now += 29_000;
    expect(await passkeys()).toBe(false);
    now += 2_000;
    expect(await passkeys()).toBe(true);
  });

  it("caches the email password setting for the same 30 seconds", async () => {
    let now = 0;
    const settings = new MemorySettings();
    const app = createApp(
      createTestDeps({ settings, clock: () => new Date(now) }),
    );
    await app.request("/api/auth/config");
    await settings.set("sign_in.email_password", true);
    expect(await (await app.request("/api/auth/config")).json()).toMatchObject({
      email_password: false,
    });
    now = 31_000;
    expect(await (await app.request("/api/auth/config")).json()).toMatchObject({
      email_password: true,
    });
  });

  it("reads once for requests that arrive together, so no one can make it read on every request", async () => {
    const adminReads = vi.spyOn(people, "hasAdmin");
    const settings = new CountingSettings();
    const app = createApp(createTestDeps({ settings }));
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => app.request("/api/auth/config")),
    );
    expect(answers.map((answer) => answer.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(settings.passkeyReads).toBe(1);
    expect(adminReads).toHaveBeenCalledTimes(1);
    adminReads.mockRestore();
  });

  it("offers no Microsoft button before the app registration has its secret", async () => {
    const settings = new MemorySettings({ "access.default_role": "none" });
    const answer = await createApp(createTestDeps({ settings })).request(
      "/api/auth/config",
    );
    expect(await answer.json()).toEqual({
      providers: [],
      passkeys: false,
      email_password: false,
      dev_sign_in: false,
      sample_data: false,
      demo: false,
      setup_pending: true,
      brand: {
        name: "Power BI Metrics Book",
        company: null,
        logo_url: null,
        custom: false,
      },
      invite_only: true,
    });
  });
});
