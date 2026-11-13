import { afterAll, expect, it, vi } from "vitest";
import { cerbosAccess, principals } from "../../test/deps.js";
import { MemorySettings } from "../../test/doubles.js";
import { putLogo, deleteLogo } from "../services/admin/branding.js";
import { PNG } from "../../test/images.js";
import { createApp } from "../app.js";
import * as people from "../services/admin/people.js";
import { closeTestPools, createTestDeps } from "../../test/deps.js";
import { signInConfigReader } from "../services/auth/sign-in-config.js";
import { joined, startSetup } from "../../test/setup-support.js";
import { cookies } from "../../test/sign-in-support.js";

afterAll(closeTestPools);

it("reports setup pending until the setup makes the first admin", async () => {
  const setup = await startSetup();
  try {
    const config = async () => (await setup.request("/api/auth/config")).json();
    expect(await config()).toMatchObject({ setup_pending: true });
    const link = await setup.openSession();
    const registration = setup.tenant.apps_registrations[0];
    const answer = await setup.post("/api/setup/steps/app_registration", link, {
      settings: {
        "powerbi.tenant_id": setup.tenant.tenant_id,
        "powerbi.app_client_id": registration?.client_id,
      },
      secrets: {
        powerbi_app_client_secret: {
          value: registration?.secret,
          expires_at: "2027-10-01T00:00:00Z",
        },
      },
    });
    expect(answer.status).toBe(200);
    const signedIn = await setup.signIn(
      setup.person("admin"),
      joined(link, cookies(answer)),
    );
    const confirmed = await setup.post(
      "/api/setup/steps/app_registration",
      signedIn.cookie,
      { confirm_email: "admin@sample.example" },
    );
    expect(confirmed.status).toBe(200);
    expect(await config()).toMatchObject({ setup_pending: false });
    const reads = vi.spyOn(people, "hasAdmin");
    const later = new Date(setup.api.clock().getTime() + 30_001);
    setup.api.clock = () => later;
    expect(await config()).toMatchObject({ setup_pending: false });
    expect(reads).not.toHaveBeenCalled();
    let now = later.getTime();
    const read = signInConfigReader(
      createTestDeps({ clock: () => new Date(now) }),
    );
    expect(await read()).toMatchObject({ setup_pending: false });
    now += 30_001;
    expect(await read()).toMatchObject({ setup_pending: false });
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  } finally {
    await setup.close();
  }
});

it("publishes the brand and invite-only setting without private configuration", async () => {
  const deps = createTestDeps();
  const { createApp } = await import("../app.js");
  const answer = (await (
    await createApp(deps).request("/api/auth/config")
  ).json()) as Record<string, unknown>;
  expect(answer.brand).toMatchObject({
    name: "Power BI Metrics Book",
    company: null,
  });
  expect(answer.invite_only).toBe(
    (await deps.settings.get("access.default_role")) === "none",
  );
  expect(JSON.stringify(answer)).not.toMatch(/client_id|issuer|secret/);
});

it("caches the brand and invite-only setting and refreshes after logo changes", async () => {
  const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
  const admin = { ...deps, principal: principals.admin };
  const app = createApp(deps);
  const config = async () => (await app.request("/api/auth/config")).json();
  await deleteLogo(admin);
  expect(await config()).toMatchObject({ brand: { logo_url: null } });
  const gets = vi.spyOn(deps.settings, "get");
  const selects = vi.spyOn(deps.db, "select");
  await config();
  expect(gets.mock.calls.map(([key]) => key)).not.toContain("branding.name");
  expect(gets.mock.calls.map(([key]) => key)).not.toContain(
    "access.default_role",
  );
  expect(selects).not.toHaveBeenCalled();
  gets.mockRestore();
  selects.mockRestore();
  await putLogo(admin, PNG);
  const logoUrl: unknown = expect.stringContaining("/api/branding/logo?v=");
  expect(await config()).toMatchObject({ brand: { logo_url: logoUrl } });
  await deleteLogo(admin);
  expect(await config()).toMatchObject({ brand: { logo_url: null } });
});
