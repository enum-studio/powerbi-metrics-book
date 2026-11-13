import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { startSetup, type SetupFixture } from "../../../test/setup-support.js";
import { lookupTenant } from "./tenant-lookup.js";

let setup: SetupFixture;
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});

it.each(["admin@sample.example", "first@ADMIN@SAMPLE.EXAMPLE"])(
  "looks up the sample tenant from %s",
  async (email) => {
    const fetch = vi.spyOn(setup.api.fetcher, "fetchFixed");
    await expect(lookupTenant(setup.api, email)).resolves.toEqual({
      tenant_id: setup.tenant.tenant_id,
      domain: "sample.example",
    });
    expect(fetch).toHaveBeenCalledWith(
      `${setup.mock.url}/sample.example/v2.0/.well-known/openid-configuration`,
      { timeout_ms: 5_000, max_bytes: 64 * 1024 },
    );
  },
);

it.each([
  "a@b",
  "a@x/y.com",
  "a@x.com?q",
  "a@.com",
  "a@x..com",
  "sample.example",
  "a@-x.com",
  "a@x-.com",
  "a@x%2f.com",
  "a@x%3f.com",
  "a@x%40.com",
  "a@x#y.com",
  "a@x\\y.com",
  "a@x y.com",
  "a@x.com\n",
  "a@x.com.",
])("refuses %s before fetching", async (email) => {
  const fetch = vi.spyOn(setup.api.fetcher, "fetchFixed");
  await expect(lookupTenant(setup.api, email)).rejects.toMatchObject({
    kind: "invalid",
    message: "Enter a work email address, such as you@yourcompany.com.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("explains an unknown domain", async () => {
  await expect(
    lookupTenant(setup.api, "a@unknown.example"),
  ).rejects.toMatchObject({
    kind: "not_found",
    message:
      "Microsoft knows no tenant for unknown.example. Paste the tenant ID from the Overview page in Entra instead.",
  });
});

it.each([
  {},
  { issuer: "https://mock.test/no-tenant/v2.0" },
  { issuer: "https://mock.test/?id=11111111-1111-4111-8111-111111111111" },
])("refuses an answer without a tenant id: %j", async (answer) => {
  vi.spyOn(setup.api.fetcher, "fetchFixed").mockResolvedValue(
    Response.json(answer),
  );
  await expect(
    lookupTenant(setup.api, "a@sample.example"),
  ).rejects.toMatchObject({ kind: "upstream" });
});

it.each(["outlook.com", "hotmail.com", "live.com"])(
  "refuses the consumers tenant for %s",
  async (domain) => {
    vi.spyOn(setup.api.fetcher, "fetchFixed").mockResolvedValue(
      Response.json({
        issuer:
          "https://login.microsoftonline.com/9188040D-6C67-4C5B-B112-36A304B66DAD/v2.0",
      }),
    );
    await expect(
      lookupTenant(setup.api, `someone@${domain}`),
    ).rejects.toMatchObject({
      kind: "invalid",
      message: "That is a personal Microsoft account. Use your work email.",
    });
  },
);
