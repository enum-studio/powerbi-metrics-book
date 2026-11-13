import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
  testConfig,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { createAuth } from "./better-auth.js";

/*
 * Better Auth exchanges Microsoft's sign-in code with powerbi.authority
 * itself, outside the guarded fetcher, so it is built only when that host
 * is reached over https, unless NODE_ENV is development or test, where the
 * authority may be the mock on loopback, or the deployment is the public
 * demo, where it may be http on the mock's host and nowhere else.
 */

afterAll(closeTestPools);

function answer(
  NODE_ENV: string,
  authority: string,
  env: Record<string, string> = {},
): Promise<Response> {
  const auth = createAuth(
    createTestDeps({
      config: testConfig("api", { NODE_ENV, ...env }),
      settings: new MemorySettings({ "powerbi.authority": authority }),
    }),
  );
  return auth.handle(
    new Request(`${TEST_PUBLIC_BASE_URL}/api/auth/get-session`),
    null,
  );
}

describe("powerbi.authority", () => {
  it("must be https in production, and the error names the setting", async () => {
    await expect(
      answer("production", "http://login.example.com"),
    ).rejects.toThrow(
      "powerbi.authority must be an https URL outside development and test.",
    );
    expect(
      (await answer("production", "https://login.example.com")).status,
    ).toBe(200);
  });

  it("may be plain http in development and test", async () => {
    for (const NODE_ENV of ["development", "test"])
      expect((await answer(NODE_ENV, "http://127.0.0.1:4100")).status).toBe(
        200,
      );
  });

  it("may be http on the mock's host in production for the demo alone", async () => {
    const DEMO = { DEMO_MODE: "1" };
    const mock = "http://powerbi-mock.localhost:3001";
    expect((await answer("production", mock, DEMO)).status).toBe(200);
    await expect(answer("production", mock)).rejects.toThrow(
      "powerbi.authority must be an https URL",
    );
    await expect(
      answer("production", "http://login.example.com", DEMO),
    ).rejects.toThrow("powerbi.authority must be an https URL");
  });
});
