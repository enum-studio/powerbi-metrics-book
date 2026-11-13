import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../test/deps.js";
import { type SetupFixture, startSetup } from "../../test/setup-support.js";

/*
 * What the setup routes' validators and documented answers add to the first
 * run (services/setup/setup.test.ts): the credential still comes first, so
 * a bad request tells a stranger nothing, and the state holds no secret.
 */

let setup: SetupFixture;
beforeAll(async () => {
  setup = await startSetup();
});
afterAll(async () => {
  await setup.close();
  await closeTestPools();
});

describe("the setup routes", () => {
  it.each(["", `${"x".repeat(306)}@sample.example`])(
    "refuses an email outside the length limits: %s",
    async (email) => {
      const response = await setup.post(
        "/api/setup/tenant",
        await setup.openSession(),
        { email },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: "invalid" });
    },
  );
  it("looks up a tenant for the setup session without saving it", async () => {
    const before = await setup.api.settings.get("powerbi.tenant_id");
    const response = await setup.post(
      "/api/setup/tenant",
      await setup.openSession(),
      { email: "admin@sample.example" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant_id: setup.tenant.tenant_id,
      domain: "sample.example",
    });
    expect(await setup.api.settings.get("powerbi.tenant_id")).toBe(before);
  });
  it("answer 404 to a caller setup is not for, whether the body is good or bad", async () => {
    for (const body of [{}, { settings: 7 }, { nope: 1 }])
      expect(
        (await setup.post("/api/setup/steps/address", "", body)).status,
      ).toBe(404);
    expect((await setup.request("/api/setup")).status).toBe(404);
  });

  it("read a bad body only for a step the setup session may run", async () => {
    const cookie = await setup.openSession();
    const bad = await setup.post("/api/setup/steps/address", cookie, {
      settings: 7,
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid" });
    // A step the session may not run is hidden before its body is read.
    expect(
      (
        await setup.post("/api/setup/steps/what_to_sync", cookie, {
          settings: 7,
        })
      ).status,
    ).toBe(404);
  });

  it("refuse a token that is empty or too long before looking it up, and hide one no link has", async () => {
    const send = (token: string) =>
      setup.post("/api/setup/session", "", { token });
    expect((await send("")).status).toBe(400);
    expect((await send("x".repeat(501))).status).toBe(400);
    expect((await send("not-a-link")).status).toBe(404);
  });

  it("answer the state with a secret's field as set or not and its date, and no value", async () => {
    const cookie = await setup.openSession();
    const state = await setup.request("/api/setup", {
      headers: { cookie },
    });
    expect(state.status).toBe(200);
    expect(state.headers.get("cache-control")).toBe("no-store");
    const { holder, steps } = (await state.json()) as {
      holder: string;
      steps: { fields: { kind: string }[] }[];
    };
    expect(holder).toBe("setup_link");
    const secrets = steps
      .flatMap((step) => step.fields)
      .filter((field) => field.kind === "secret");
    expect(secrets.length).toBeGreaterThan(0);
    for (const field of secrets)
      expect(Object.keys(field).sort()).toEqual([
        "expires_at",
        "kind",
        "name",
        "set",
      ]);
  });
});
