import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { publishRecipient } from "./identities.js";
import { readersOf } from "./readers.js";
import { createSecretReader, createSecretWriter } from "./store.js";
import {
  newIdentity,
  publishedIdentities,
  rolledBack,
} from "../../../test/secrets-support.js";

afterAll(closeTestPools);

const clock = () => new Date("2026-10-25T12:00:00Z");
const APP_SECRET = "test-app-secret-not-real-0001";

describe("the secret store", () => {
  it("refuses a name that is not a secret", () => {
    expect(() => readersOf("powerbi_tenant_password")).toThrow(
      "There is no secret named powerbi_tenant_password.",
    );
  });

  it("reads the environment's value first, then the database's, else null", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const identities = await publishedIdentities(db);
      await createSecretWriter({ container: "api", db, clock }).write(
        "openai_api_key",
        "test-embedding-key-not-real",
        principals.admin,
        null,
      );
      const env = { OPENAI_API_KEY: "test-embedding-key-from-environment" };
      const fromEnv = createSecretReader(
        { container: "worker", db, env },
        identities.worker,
      );
      await expect(fromEnv.read("openai_api_key")).resolves.toBe(
        "test-embedding-key-from-environment",
      );
      const reader = createSecretReader(
        { container: "worker", db, env: {} },
        identities.worker,
      );
      await expect(reader.read("openai_api_key")).resolves.toBe(
        "test-embedding-key-not-real",
      );
      await expect(reader.read("gemini_api_key")).resolves.toBeNull();
    }));

  it("refuses a control character in any secret, and a header's impossible character in an API key, quoting none of it", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      await publishedIdentities(db);
      const writer = createSecretWriter({ container: "api", db, clock });
      const refused: [Parameters<typeof writer.write>[0], string][] = [
        ["openai_api_key", "sk-test-not-real\nX-Injected: 1"],
        ["gemini_api_key", "test-key-not-real\u0000"],
        ["powerbi_app_client_secret", `${APP_SECRET}\r`],
        ["powerbi_app_client_secret", `${APP_SECRET}\u0085`],
        ["openai_api_key", "sk-test-not-real- "],
      ];
      for (const [name, value] of refused) {
        const error = await writer
          .write(name, value, principals.admin, null)
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ kind: "invalid" });
        expect((error as Error).message).not.toContain("not-real");
      }
      // A client secret is sent in a form body, which carries any character.
      await writer.write(
        "powerbi_app_client_secret",
        `${APP_SECRET}-é€`,
        principals.admin,
        null,
      );
    }));

  it("refuses to save a secret for a container that has never started", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const writer = createSecretWriter({ container: "api", db, clock });
      await expect(
        writer.write(
          "powerbi_scanner_client_secret",
          APP_SECRET,
          principals.admin,
          null,
        ),
      ).rejects.toThrow(
        "The worker has not started yet: start it, then save powerbi_scanner_client_secret again.",
      );
    }));

  it("lists what is set, by whom and until when, and never the value", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      await publishedIdentities(db);
      const writer = createSecretWriter({ container: "api", db, clock });
      const expiry = new Date("2027-10-01T00:00:00Z");
      await writer.write(
        "powerbi_app_client_secret",
        APP_SECRET,
        principals.admin,
        expiry,
      );
      await writer.write(
        "sign_in_okta_client_secret",
        "short",
        principals.admin,
        null,
      );
      await writer.write(
        "openai_api_key",
        "test-embedding-key-not-real",
        principals.admin,
        null,
      );
      // The worker's identity volume is lost: it starts with a new identity.
      await publishRecipient(db, "worker", (await newIdentity()).recipient);

      const listed = new Map(
        (await writer.list()).map((entry) => [entry.name, entry]),
      );
      expect(listed.get("powerbi_app_client_secret")).toMatchObject({
        readers: ["api"],
        set: true,
        needs_reentry_for: [],
        hint: APP_SECRET.slice(-4),
        set_by: principals.admin.id,
        set_at: clock(),
        expires_at: expiry,
        check_status: "unchecked",
      });
      expect(listed.get("sign_in_okta_client_secret")).toMatchObject({
        set: true,
        hint: null,
      });
      expect(listed.get("openai_api_key")).toMatchObject({
        readers: ["api", "worker"],
        needs_reentry_for: ["worker"],
      });
      expect(listed.get("powerbi_scanner_client_secret")).toMatchObject({
        set: false,
        needs_reentry_for: [],
        hint: null,
      });
    }));
});
