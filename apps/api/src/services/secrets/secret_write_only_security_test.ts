import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import type { SecretName } from "../../context.js";
import * as age from "./age.js";
import * as identities from "./identities.js";
import * as readers from "./readers.js";
import * as rotate from "./rotate.js";
import * as store from "./store.js";
import {
  createSecretReader,
  createSecretWriter,
  type SecretWrite,
} from "./store.js";
import {
  publishedIdentities,
  rolledBack,
} from "../../../test/secrets-support.js";

// A secret is write-only: once saved, nothing hands its value to anyone but
// a container that reads it (spec, Settings and secrets).

afterAll(closeTestPools);

const APP_SECRET = "test-app-secret-not-real-0001";

describe("secrets are write-only", () => {
  it("export no function beyond the ones reviewed here", () => {
    // decryptWith and the readers return values, but only to a caller holding
    // the reader's identity, which never leaves that container's volume. A new
    // export fails this test until it is reviewed and added.
    const reviewed: [object, string[]][] = [
      [age, ["decryptWith", "encryptFor", "generateIdentity", "recipientOf"]],
      [
        identities,
        [
          "identityPath",
          "identityVariable",
          "loadIdentity",
          "publishRecipient",
          "readIdentityFile",
        ],
      ],
      [readers, ["FIXED_SECRET_NAMES", "readersOf"]],
      [rotate, ["rotateIdentity"]],
      [store, ["createSecretReader", "createSecretWriter"]],
    ];
    for (const [module, exports] of reviewed)
      expect(Object.keys(module).sort()).toEqual(exports);
  });

  it("give no value back from the writer, its list or its audit event", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      await publishedIdentities(db);
      const events: SecretWrite[] = [];
      const onWrite = (event: SecretWrite) => {
        events.push(event);
        return Promise.resolve();
      };
      const writer = createSecretWriter({
        container: "api",
        db,
        clock: () => new Date(),
        onWrite,
      });

      await expect(
        writer.write(
          "powerbi_app_client_secret",
          APP_SECRET,
          principals.admin,
          null,
        ),
      ).resolves.toBeUndefined();
      await expect(writer.generate("result_link_key")).resolves.toBeUndefined();
      const listed = JSON.stringify([await writer.list(), events]);
      expect(listed).not.toContain(APP_SECRET);
      expect(listed).toContain(APP_SECRET.slice(-4));
      expect(events.map((event) => event.name)).toEqual([
        "powerbi_app_client_secret",
        "result_link_key",
      ]);
    }));

  it("are refused to a container that does not read them", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const loaded = await publishedIdentities(db);
      const worker = createSecretReader(
        { container: "worker", db, env: {} },
        loaded.worker,
      );
      const apiOnly: SecretName[] = [
        "powerbi_app_client_secret",
        "result_link_key",
        "sign_in_google_client_secret",
      ];
      for (const name of apiOnly) {
        await expect(worker.read(name)).rejects.toThrow(
          `The worker does not read ${name}.`,
        );
      }
      expect(() =>
        createSecretWriter({
          container: "worker",
          db,
          clock: () => new Date(),
        }),
      ).toThrow("Only the api writes secrets.");
    }));
});
