import { inArray } from "drizzle-orm";
import { escapeIdentifier } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, principals, testPool } from "../../../test/deps.js";
import {
  holdingSecretsTables,
  publishedIdentities,
  rolledBack,
} from "../../../test/secrets-support.js";
import type { SecretName } from "../../context.js";
import { createDb } from "../../db/client.js";
import { secret_ciphertext } from "../../db/schema/secrets.js";
import { createSecretWriter, type SecretsDb } from "./store.js";

// A database copy holds no secret in clear and nothing that opens one: the
// identities live in each container's own volume (spec, Security).

afterAll(closeTestPools);

const clock = () => new Date();
const VALUES: [SecretName, string][] = [
  ["powerbi_app_client_secret", "test-app-secret-not-real-0001"],
  ["powerbi_scanner_client_secret", "test-scanner-secret-not-real-0002"],
  ["openai_api_key", "test-embedding-key-not-real-0003"],
];
const NAMES = VALUES.map(([name]) => name);
const IDENTITY_PREFIX = "AGE-SECRET-KEY-1";

async function writeAll(db: SecretsDb): Promise<void> {
  const writer = createSecretWriter({ container: "api", db, clock });
  for (const [name, value] of VALUES)
    await writer.write(name, value, principals.admin, null);
}

/** Every column of every row of every table, as the migrator, which owns them all and is not held by row level security. */
async function dumpEveryTable(): Promise<Buffer> {
  const migrator = testPool("migrator");
  const { rows: tables } = await migrator.query<{ name: string }>(
    "select tablename as name from pg_tables where schemaname = 'public'",
  );
  const parts: Buffer[] = [];
  for (const { name } of tables) {
    const { rows } = await migrator.query<Record<string, unknown>>(
      `select * from public.${escapeIdentifier(name)}`,
    );
    for (const row of rows) {
      for (const value of Object.values(row)) {
        // bytea arrives as its raw bytes; everything else as its text.
        if (Buffer.isBuffer(value)) parts.push(value);
        else
          parts.push(
            Buffer.from(
              typeof value === "string" ? value : JSON.stringify(value),
            ),
          );
      }
    }
  }
  return Buffer.concat(parts);
}

describe("secrets at rest", () => {
  it("never hold the value in a stored ciphertext", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      await publishedIdentities(db);
      await writeAll(db);
      const rows = await db.select().from(secret_ciphertext);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        for (const [, value] of VALUES)
          expect(Buffer.from(row.ciphertext).includes(value)).toBe(false);
      }
    }));

  it("leave neither a value nor an identity in a dump of every table", async () => {
    const api = createDb(testPool("api_rw"));
    // The migrator's connection sees only committed rows, so this test
    // commits and removes what it wrote, holding off every other secrets test.
    await holdingSecretsTables(async () => {
      const identities = await publishedIdentities(api);
      try {
        await writeAll(api);
        const dump = await dumpEveryTable();
        // The dump holds the rows written: the recipients and the ciphertexts.
        const ciphertexts = await api
          .select()
          .from(secret_ciphertext)
          .where(inArray(secret_ciphertext.name, NAMES));
        expect(ciphertexts).toHaveLength(4);
        for (const row of ciphertexts)
          expect(dump.includes(Buffer.from(row.ciphertext))).toBe(true);
        expect(dump.includes(identities.worker.recipient)).toBe(true);

        for (const [name, value] of VALUES)
          expect(dump.includes(value), name).toBe(false);
        for (const [container, { identity }] of Object.entries(identities)) {
          const secretPart = identity.slice(IDENTITY_PREFIX.length);
          for (const form of [secretPart, secretPart.toLowerCase()])
            expect(dump.includes(form), container).toBe(false);
        }
      } finally {
        const migrator = testPool("migrator");
        await migrator.query("delete from secret where name = any($1)", [
          NAMES,
        ]);
        await migrator.query(
          "delete from container_identity where recipient = any($1)",
          [[identities.api.recipient, identities.worker.recipient]],
        );
      }
    });
  });
});
