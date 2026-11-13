import type * as fsPromises from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TEST_RUNNER } from "../../../test/database.js";
import {
  closeTestPools,
  principals,
  testConfig,
  testPool,
} from "../../../test/deps.js";
import type { SecretName } from "../../context.js";
import { createDb } from "../../db/client.js";
import { createLogger } from "../../log.js";
import { jobRequest } from "../../db/schema/jobs.js";
import {
  container_identity,
  secret,
  secret_ciphertext,
} from "../../db/schema/secrets.js";
import { decryptWith, recipientOf } from "./age.js";
import {
  identityPath,
  loadIdentity,
  publishRecipient,
  readIdentityFile,
} from "./identities.js";
import { rotateIdentity } from "./rotate.js";
import { createSecretReader, createSecretWriter } from "./store.js";
import { newIdentity, rolledBack } from "../../../test/secrets-support.js";

// Lets one test make removing a file fail, as a busy or read-only volume
// would, after the rotation has committed.
const removal = vi.hoisted(() => ({ fails: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      removal.fails
        ? Promise.reject(new Error("EBUSY: resource busy or locked"))
        : actual.rm(...args),
  };
});

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await closeTestPools();
});

async function apiConfig() {
  const dir = await mkdtemp(join(tmpdir(), "pbmb-age-"));
  dirs.push(dir);
  return { ...testConfig("api"), identity_dir: dir, age_identity: null };
}

const clock = () => new Date();
const logger = createLogger("error", () => {});
const APP_SECRET = "test-app-secret-not-real-0001";
const SCANNER_SECRET = "test-scanner-secret-not-real-0003";
const READ_BY_API: SecretName[] = [
  "powerbi_app_client_secret",
  "openai_api_key",
  "result_link_key",
];

describe("rotateIdentity", () => {
  it("leaves every secret readable with the new identity and none with the old", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const config = await apiConfig();
      const old = await loadIdentity(config, db);
      await publishRecipient(db, "worker", (await newIdentity()).recipient);
      const writer = createSecretWriter({ container: "api", db, clock });
      await writer.write(
        "powerbi_app_client_secret",
        APP_SECRET,
        principals.admin,
        null,
      );
      await writer.write(
        "openai_api_key",
        "test-embedding-key-not-real-0002",
        principals.admin,
        null,
      );
      await writer.generate("result_link_key");
      const queued = async () =>
        (
          await db
            .select()
            .from(jobRequest)
            .where(
              and(
                eq(jobRequest.job, "rekey_tokens"),
                eq(jobRequest.status, "queued"),
              ),
            )
        ).length;
      const queuedBefore = await queued();

      const rotated = await rotateIdentity({
        config,
        db,
        clock,
        logger,
        identity: old,
      });
      expect(rotated.reencrypted).toBe(3);
      // The api keeps its old key for rekey_tokens, queued in the same transaction.
      expect((await readdir(config.identity_dir)).toSorted()).toEqual([
        "api.key",
        expect.stringMatching(/^api\.key\.retired-/) as unknown,
      ]);
      expect(rotated.left_behind).toBeNull();
      expect(await queued()).toBe(queuedBefore + 1);

      const fresh = await loadIdentity(config, db);
      expect(fresh.recipient).toBe(rotated.recipient);
      const reader = createSecretReader(
        { container: "api", db, env: {} },
        fresh,
      );
      await expect(reader.read("powerbi_app_client_secret")).resolves.toBe(
        APP_SECRET,
      );
      for (const name of READ_BY_API)
        await expect(reader.read(name)).resolves.toEqual(expect.any(String));
      const rows = await db
        .select()
        .from(secret_ciphertext)
        .where(eq(secret_ciphertext.reader, "api"));
      expect(rows).toHaveLength(3);
      for (const row of rows)
        await expect(
          decryptWith(old.identity, row.ciphertext),
        ).rejects.toThrow();
      const current = await db
        .select()
        .from(container_identity)
        .where(eq(container_identity.container, "api"));
      expect(
        current
          .filter((row) => row.retired_at === null)
          .map((row) => row.recipient),
      ).toEqual([fresh.recipient]);
    }));

  it("puts the old key file back when re-encrypting fails", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const config = await apiConfig();
      const old = await loadIdentity(config, db);
      // A ciphertext no identity opens makes the run fail half-way.
      await db
        .insert(secret)
        .values({ name: "result_link_key", readers: ["api"], set_at: clock() });
      await db.insert(secret_ciphertext).values({
        name: "result_link_key",
        reader: "api",
        recipient: old.recipient,
        ciphertext: new Uint8Array([1, 2, 3]),
      });

      await expect(
        rotateIdentity({ config, db, clock, logger, identity: old }),
      ).rejects.toThrow();
      expect(await readdir(config.identity_dir)).toEqual(["api.key"]);
      expect(
        await recipientOf(await readIdentityFile(identityPath(config))),
      ).toBe(old.recipient);
      const current = await db
        .select()
        .from(container_identity)
        .where(eq(container_identity.container, "api"));
      expect(current.map((row) => [row.recipient, row.retired_at])).toEqual([
        [old.recipient, null],
      ]);
    }));

  it("keeps the new key and every secret readable when the worker's retired key cannot be removed", () =>
    rolledBack(testPool(TEST_RUNNER), async (db) => {
      const as = (role: "api_rw" | "worker_rw") =>
        db.execute(sql`set local role ${sql.identifier(role)}`);
      const dir = (await apiConfig()).identity_dir;
      const config = {
        ...testConfig("worker"),
        identity_dir: dir,
        age_identity: null,
      };
      await as("worker_rw");
      const old = await loadIdentity(config, db);
      // The api writes the scanner's secret, for the worker alone.
      await as("api_rw");
      await createSecretWriter({ container: "api", db, clock }).write(
        "powerbi_scanner_client_secret",
        SCANNER_SECRET,
        principals.admin,
        null,
      );
      await as("worker_rw");
      const warnings: string[] = [];
      const warn = createLogger("warn", (line) => warnings.push(line));

      removal.fails = true;
      const rotated = await rotateIdentity({
        config,
        db,
        clock,
        logger: warn,
        identity: old,
      }).finally(() => {
        removal.fails = false;
      });
      expect(rotated.left_behind).toMatch(/\/worker\.key\.retired-[^/]+$/);
      expect(warnings).toHaveLength(1);
      const fresh = await loadIdentity(config, db);
      expect(fresh.recipient).toBe(rotated.recipient);
      const reader = createSecretReader(
        { container: "worker", db, env: {} },
        fresh,
      );
      await expect(reader.read("powerbi_scanner_client_secret")).resolves.toBe(
        SCANNER_SECRET,
      );
    }));

  it("refuses to replace an identity the environment sets", async () => {
    const config = {
      ...(await apiConfig()),
      age_identity: (await newIdentity()).identity,
    };
    const db = createDb(testPool("api_rw"));
    const identity = await newIdentity();
    await expect(
      rotateIdentity({ config, db, clock, logger, identity }),
    ).rejects.toThrow("API_AGE_IDENTITY sets the api's identity");
  });
});
