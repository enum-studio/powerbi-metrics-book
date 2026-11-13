import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import type { SecretName } from "../../context.js";
import { createAuth } from "./better-auth.js";

afterAll(closeTestPools);

const getSession = () =>
  new Request(`${TEST_PUBLIC_BASE_URL}/api/auth/get-session`);

describe("createAuth", () => {
  it("reads settings and decrypts secrets at most every 30 seconds", async () => {
    const reads: SecretName[] = [];
    let now = Date.parse("2026-10-25T12:00:00Z");
    const auth = createAuth(
      createTestDeps({
        clock: () => new Date(now),
        secrets: {
          read: (name) => {
            reads.push(name);
            return Promise.resolve(null);
          },
        },
      }),
    );
    await auth.handle(getSession(), null);
    await auth.handle(getSession(), null);
    now += 29_000;
    await auth.handle(getSession(), null);
    expect(reads).toEqual(["powerbi_app_client_secret"]);
    now += 2_000;
    await auth.handle(getSession(), null);
    expect(reads).toHaveLength(2);
  });

  it("refuses to build with an OpenID Connect provider that has no issuer, naming the setting", async () => {
    const auth = createAuth(
      createTestDeps({
        settings: new MemorySettings({
          "sign_in.providers": [
            {
              id: "broken",
              kind: "oidc",
              label: "broken",
              client_id: "client",
              issuer: null,
            },
          ],
        }),
        secrets: {
          read: () => Promise.resolve("a secret"),
        },
      }),
    );
    await expect(auth.handle(getSession(), null)).rejects.toThrow(
      "sign_in.providers: the OpenID Connect provider broken has no issuer.",
    );
  });
});
