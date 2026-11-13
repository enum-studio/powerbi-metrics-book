import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import { secret_ciphertext } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import { decryptWith } from "./age.js";
import { createSecretReader, createSecretWriter } from "./store.js";
import {
  publishedIdentities,
  rolledBack,
} from "../../../test/secrets-support.js";

// The internet-facing api must never read the tenant-wide credential: the
// scanner's secret is encrypted for the worker alone (spec, Security).

afterAll(closeTestPools);

const SCANNER_SECRET = "test-scanner-secret-not-real-0001";

describe("the scanner's secret", () => {
  it("cannot be read by a reader holding the api's identity", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const identities = await publishedIdentities(db);
      const writer = createSecretWriter({
        container: "api",
        db,
        clock: () => new Date(),
      });
      await writer.write(
        "powerbi_scanner_client_secret",
        SCANNER_SECRET,
        principals.admin,
        null,
      );

      const api = createSecretReader(
        { container: "api", db, env: {} },
        identities.api,
      );
      await expect(api.read("powerbi_scanner_client_secret")).rejects.toThrow(
        ServiceError,
      );

      // api_rw can select the worker's row; the api's identity still opens nothing.
      const rows = await db
        .select()
        .from(secret_ciphertext)
        .where(eq(secret_ciphertext.name, "powerbi_scanner_client_secret"));
      expect(rows.map((row) => row.reader)).toEqual(["worker"]);
      for (const row of rows) {
        await expect(
          decryptWith(identities.api.identity, row.ciphertext),
        ).rejects.toThrow();
      }

      const worker = createSecretReader(
        { container: "worker", db, env: {} },
        identities.worker,
      );
      await expect(worker.read("powerbi_scanner_client_secret")).resolves.toBe(
        SCANNER_SECRET,
      );
    }));

  it("is refused to the api even when the api's environment carries it", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const identities = await publishedIdentities(db);
      const env = { POWERBI_SCANNER_CLIENT_SECRET: SCANNER_SECRET };
      const api = createSecretReader(
        { container: "api", db, env },
        identities.api,
      );
      await expect(api.read("powerbi_scanner_client_secret")).rejects.toThrow(
        "The api does not read powerbi_scanner_client_secret.",
      );
    }));
});
