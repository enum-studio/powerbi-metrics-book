import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  principals,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import {
  holdingSecretsTables,
  newIdentity,
} from "../../../test/secrets-support.js";
import { createDb } from "../../db/client.js";
import {
  container_identity,
  secret_ciphertext,
} from "../../db/schema/secrets.js";
import { createLogger } from "../../log.js";
import { loadIdentity, publishRecipient } from "./identities.js";
import { rotateIdentity } from "./rotate.js";
import { createSecretReader, createSecretWriter } from "./store.js";

// The worker may write to the secrets tables only to rotate its own identity.
// A worker that could change the api's rows could replace result_link_key
// with a value it knows and forge result links (spec, Security).

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await closeTestPools();
});

const clock = () => new Date();
const logger = createLogger("error", () => {});
const EMBEDDING_KEY = "test-embedding-key-not-real-0001";
const SCANNER_SECRET = "test-scanner-secret-not-real-0002";
const NAMES = ["openai_api_key", "powerbi_scanner_client_secret"] as const;

/** The api's rows as the migrator sees them, past row level security. */
async function apiRows(recipient: string): Promise<unknown[]> {
  const migrator = testPool("migrator");
  const ciphertexts = await migrator.query<Record<string, unknown>>(
    "select * from secret_ciphertext where reader = 'api' and name = any($1)",
    [NAMES],
  );
  const identities = await migrator.query<Record<string, unknown>>(
    "select * from container_identity where recipient = $1",
    [recipient],
  );
  return [...ciphertexts.rows, ...identities.rows];
}

describe("the worker's own rows", () => {
  it("are all it can see or change, and its rotation still succeeds end to end", async () => {
    const api = createDb(testPool("api_rw"));
    const worker = createDb(testPool("worker_rw"));
    const dir = await mkdtemp(join(tmpdir(), "pbmb-age-"));
    dirs.push(dir);
    const config = { ...testConfig("worker"), identity_dir: dir };
    // The worker's connection sees only committed rows, so this test commits
    // and removes what it wrote, holding off every other secrets test meanwhile.
    await holdingSecretsTables(async () => {
      const apiIdentity = await newIdentity();
      const published = [apiIdentity.recipient];
      try {
        await publishRecipient(api, "api", apiIdentity.recipient);
        const old = await loadIdentity(config, worker);
        published.push(old.recipient);
        const writer = createSecretWriter({ container: "api", db: api, clock });
        await writer.write(NAMES[0], EMBEDDING_KEY, principals.admin, null);
        await writer.write(NAMES[1], SCANNER_SECRET, principals.admin, null);
        const before = await apiRows(apiIdentity.recipient);
        expect(before).toHaveLength(2);

        const seen = await worker.select().from(secret_ciphertext);
        expect(seen.map((row) => [row.name, row.reader]).sort()).toEqual([
          [NAMES[0], "worker"],
          [NAMES[1], "worker"],
        ]);
        await expect(
          worker.insert(container_identity).values({
            container: "api",
            recipient: (await newIdentity()).recipient,
          }),
        ).rejects.toHaveProperty(
          "cause.message",
          'new row violates row-level security policy for table "container_identity"',
        );

        const rotated = await rotateIdentity({
          config,
          db: worker,
          clock,
          logger,
          identity: old,
        });
        published.push(rotated.recipient);
        expect(rotated.reencrypted).toBe(2);
        const fresh = await loadIdentity(config, worker);
        const reader = createSecretReader(
          { container: "worker", db: worker, env: {} },
          fresh,
        );
        await expect(reader.read(NAMES[0])).resolves.toBe(EMBEDDING_KEY);
        await expect(reader.read(NAMES[1])).resolves.toBe(SCANNER_SECRET);
        const apiReader = createSecretReader(
          { container: "api", db: api, env: {} },
          apiIdentity,
        );
        await expect(apiReader.read(NAMES[0])).resolves.toBe(EMBEDDING_KEY);

        // Last, as they spoil the worker's own rows: updates with no WHERE
        // and no RETURNING, which only the update policies hold back.
        await worker
          .update(secret_ciphertext)
          .set({ ciphertext: new Uint8Array([1]) });
        await worker.update(container_identity).set({ retired_at: clock() });
        expect(await apiRows(apiIdentity.recipient)).toEqual(before);
      } finally {
        // As the migrator, which owns the tables: neither role may delete.
        const migrator = testPool("migrator");
        await migrator.query("delete from secret where name = any($1)", [
          NAMES,
        ]);
        await migrator.query(
          "delete from container_identity where recipient = any($1)",
          [published],
        );
      }
    });
  });
});
