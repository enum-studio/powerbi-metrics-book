import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  testConfig,
} from "../../../test/deps.js";
import { rolledBack } from "../../../test/sample-mirror.js";
import { newIdentity } from "../../../test/secrets-support.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { createLogger } from "../../log.js";
import { decryptWith } from "../secrets/age.js";
import { publishRecipient, readIdentityFile } from "../secrets/identities.js";
import { rotateIdentity } from "../secrets/rotate.js";
import { rekeyTokens } from "./jobs.js";
import { sealTokens } from "./store.js";
import { createVault } from "./vault.js";

/*
 * rekey_tokens seals with the key the api holds in memory, never for a
 * recipient a row in the database names: api_rw may write container_identity.
 */

afterAll(closeTestPools);

describe("rekey_tokens", () => {
  it("seals no token for a recipient forged into container_identity", () =>
    rolledBack("api_rw", async (db) => {
      const dir = await mkdtemp(join(tmpdir(), "pbmb-rekey-"));
      try {
        const old = await newIdentity();
        await writeFile(join(dir, "api.key"), `${old.identity}\n`, {
          mode: 0o400,
        });
        const config = {
          ...testConfig("api"),
          identity_dir: dir,
          age_identity: null,
        };
        const id = `rekey-${randomUUID()}`;
        await db.insert(user).values({
          id,
          name: "rekey",
          email: `${id}@sample.example`,
        });
        const tokens = ["sample-access-token", "sample-refresh-token"];
        await db.insert(powerbiConnection).values({
          user_id: id,
          microsoft_object_id: randomUUID(),
          ...(await sealTokens(createVault(config, old), {
            access_token: tokens[0] ?? "",
            refresh_token: tokens[1] ?? "",
            expires_at: new Date(),
            scopes: [],
          })),
          status: "connected",
          connected_at: new Date(),
        });
        const rotated = await rotateIdentity({
          config,
          db,
          clock: () => new Date(),
          logger: createLogger("error", () => {}),
          identity: old,
        });
        const restarted = createVault(config, {
          identity: await readIdentityFile(join(dir, "api.key")),
          recipient: rotated.recipient,
        });
        const forged = await newIdentity();
        await publishRecipient(db, "api", forged.recipient);

        await expect(
          rekeyTokens(createTestDeps({ config, db, vault: restarted })),
        ).rejects.toThrow("Restart the api, then run rekey_tokens");
        const [row] = await db
          .select()
          .from(powerbiConnection)
          .where(eq(powerbiConnection.user_id, id));
        const ciphertexts = [
          row?.access_token_ciphertext ?? new Uint8Array(),
          row?.refresh_token_ciphertext ?? new Uint8Array(),
        ];
        for (const [index, ciphertext] of ciphertexts.entries()) {
          await expect(restarted.open(ciphertext)).resolves.toBe(tokens[index]);
          await expect(
            decryptWith(forged.identity, ciphertext),
          ).rejects.toThrow();
        }
        expect(await readdir(dir)).toHaveLength(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }));
});
