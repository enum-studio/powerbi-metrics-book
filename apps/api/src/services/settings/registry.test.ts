import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../test/doubles.js";
import { OKTA_PROVIDER } from "../../../test/settings-fixture.js";
import { isSettingKey, SETTING_KEYS, SETTINGS } from "./registry.js";

describe("the registry", () => {
  // DEFAULT_SETTINGS is typed SettingValues, so it has a value for every key
  // the type declares, and the registry must match it key for key.
  it("has an entry for every key of SettingValues, and no other", () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS).sort(),
    );
  });

  it("gives every setting a default its own schema accepts", () => {
    for (const key of SETTING_KEYS) {
      expect(
        SETTINGS[key].schema.safeParse(SETTINGS[key].default).success,
        key,
      ).toBe(true);
    }
  });

  it("agrees with the test double's defaults, which are the spec's table", () => {
    for (const key of SETTING_KEYS) {
      expect(SETTINGS[key].default, key).toEqual(DEFAULT_SETTINGS[key]);
    }
  });

  it("knows its keys, and not the names an object inherits", () => {
    expect(isSettingKey("results.ttl_hours")).toBe(true);
    expect(isSettingKey("constructor")).toBe(false);
    expect(isSettingKey("results.ttl")).toBe(false);
  });
});

describe("the schemas", () => {
  it.each([
    "9188040d-6c67-4c5b-b112-36a304b66dad",
    "9188040D-6C67-4C5B-B112-36A304B66DAD",
  ])("refuse the consumers tenant: %s", (tenant) => {
    expect(() => SETTINGS["powerbi.tenant_id"].schema.parse(tenant)).toThrow(
      "That is a personal Microsoft account. Use your work tenant ID.",
    );
  });
  it("take the workspaces as all or a list of ids, and an empty list is a list", () => {
    const { schema } = SETTINGS["powerbi.sync.workspaces.include"];
    expect(schema.safeParse("all").success).toBe(true);
    expect(schema.safeParse([]).success).toBe(true);
    expect(
      schema.safeParse(["22222222-2222-4222-8222-222222222222"]).success,
    ).toBe(true);
    expect(schema.safeParse("none").success).toBe(false);
    expect(schema.safeParse(["not an id"]).success).toBe(false);
  });

  it("take a cron line croner reads and no other text", () => {
    const { schema } = SETTINGS["powerbi.sync.schedule"];
    expect(schema.safeParse("*/15 * * * *").success).toBe(true);
    expect(schema.safeParse("every hour").success).toBe(false);
    expect(schema.safeParse("61 * * * *").success).toBe(false);
  });

  it("take http and https addresses only", () => {
    const { schema } = SETTINGS["powerbi.api_url"];
    expect(schema.safeParse("http://powerbi-mock.localhost:4010").success).toBe(
      true,
    );
    expect(schema.safeParse("ftp://example.com").success).toBe(false);
    expect(schema.safeParse("api.powerbi.com").success).toBe(false);
  });

  it("take a sign-in provider with what its kind needs", () => {
    const { schema } = SETTINGS["sign_in.providers"];
    expect(schema.safeParse([OKTA_PROVIDER]).success).toBe(true);
    expect(
      schema.safeParse([{ ...OKTA_PROVIDER, kind: "google", issuer: null }])
        .success,
    ).toBe(true);
    expect(schema.safeParse([{ ...OKTA_PROVIDER, issuer: null }]).success).toBe(
      false,
    );
  });

  it("refuse a provider id used twice, one that is not a secret name's part, and Microsoft's", () => {
    const { schema } = SETTINGS["sign_in.providers"];
    expect(schema.safeParse([OKTA_PROVIDER, OKTA_PROVIDER]).success).toBe(
      false,
    );
    expect(
      schema.safeParse([{ ...OKTA_PROVIDER, id: "Okta SSO" }]).success,
    ).toBe(false);
    expect(
      schema.safeParse([{ ...OKTA_PROVIDER, id: "microsoft" }]).success,
    ).toBe(false);
  });

  it("refuse an id reserved for another way of signing in", () => {
    const { schema } = SETTINGS["sign_in.providers"];
    for (const id of ["dev", "passkey", "credential", "google"])
      expect(schema.safeParse([{ ...OKTA_PROVIDER, id }]).success, id).toBe(
        false,
      );
    const google = { ...OKTA_PROVIDER, kind: "google", issuer: null };
    expect(schema.safeParse([{ ...google, id: "google" }]).success).toBe(true);
    expect(schema.safeParse([{ ...google, id: "dev" }]).success).toBe(false);
  });
});

it.each([0, 366, 1.5])("refuses usage retention %s", (days) => {
  expect(SETTINGS["usage.retention_days"].schema.safeParse(days).success).toBe(
    false,
  );
});
