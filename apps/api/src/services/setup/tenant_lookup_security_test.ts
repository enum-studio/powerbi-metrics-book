import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeTestPools, principals } from "../../../test/deps.js";
import { startSetup, type SetupFixture } from "../../../test/setup-support.js";
import { cookies, fromSpa } from "../../../test/sign-in-support.js";
import { createApp } from "../../app.js";
import { roleAssignment } from "../../db/schema/roles.js";
import { setupLink } from "../../db/schema/setup.js";

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await setup.api.db.delete(roleAssignment);
  await setup.api.db.delete(setupLink);
});
const body = { email: "admin@sample.example" };
const path = "/api/setup/tenant";

it.each(["missing", "expired", "spent"])(
  "hides tenant lookup from a %s setup session",
  async (kind) => {
    const cookie = kind === "missing" ? "" : await setup.openSession();
    if (kind === "expired")
      await setup.api.db
        .update(setupLink)
        .set({ session_expires_at: new Date(0) });
    if (kind === "spent") await setup.api.db.delete(setupLink);
    const fetch = vi.spyOn(setup.api.fetcher, "fetchFixed");
    expect((await setup.post(path, cookie, body)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["a@x/y.com", "a@x.com?q"])(
  "never fetches a domain with path or query characters: %s",
  async (email) => {
    const cookie = await setup.openSession();
    const fetch = vi.spyOn(setup.api.fetcher, "fetchFixed");
    expect((await setup.post(path, cookie, { email })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("hides lookup from a viewer and allows an admin's browser session", async () => {
  const email = "viewer@sample.example";
  await setup.api.db.insert(roleAssignment).values({
    role: "viewer",
    subject_kind: "person",
    subject: email,
    granted_by: principals.admin.id,
  });
  const app = createApp({
    ...setup.api,
    config: { ...setup.api.config, allow_dev_sign_in: true },
  });
  const signed = await app.request(
    "/api/auth/dev/sign-in",
    fromSpa("", { email }),
  );
  expect(signed.status).toBe(200);
  const cookie = cookies(signed);
  const fetch = vi.spyOn(setup.api.fetcher, "fetchFixed");
  expect((await app.request(path, fromSpa(cookie, body))).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  await setup.api.db.insert(roleAssignment).values({
    role: "admin",
    subject_kind: "person",
    subject: email,
    granted_by: principals.admin.id,
  });
  const answer = await app.request(path, fromSpa(cookie, body));
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    tenant_id: setup.tenant.tenant_id,
    domain: "sample.example",
  });
});
