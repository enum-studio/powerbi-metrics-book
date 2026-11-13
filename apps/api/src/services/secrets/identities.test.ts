import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, testConfig, testPool } from "../../../test/deps.js";
import type { Config } from "../../config.js";
import type { Container } from "../../context.js";
import { container_identity } from "../../db/schema/secrets.js";
import { identityPath, loadIdentity } from "./identities.js";
import { newIdentity, rolledBack } from "../../../test/secrets-support.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await closeTestPools();
});

async function configIn(
  container: Container,
  ageIdentity: string | null = null,
): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "pbmb-age-"));
  dirs.push(dir);
  return {
    ...testConfig(container),
    identity_dir: dir,
    age_identity: ageIdentity,
  };
}

describe("loadIdentity", () => {
  it("makes a file only its owner can read on first start, then keeps using it", () =>
    rolledBack(testPool("api_rw"), async (db) => {
      const config = await configIn("api");
      const first = await loadIdentity(config, db);
      expect((await stat(identityPath(config))).mode & 0o777).toBe(0o400);
      const again = await loadIdentity(config, db);
      expect(again.recipient).toBe(first.recipient);
      const rows = await db
        .select()
        .from(container_identity)
        .where(eq(container_identity.container, "api"));
      expect(rows.map((row) => [row.recipient, row.retired_at])).toEqual([
        [first.recipient, null],
      ]);
    }));

  it("refuses an identity file other users can read", () =>
    rolledBack(testPool("worker_rw"), async (db) => {
      const config = await configIn("worker");
      const path = identityPath(config);
      await writeFile(path, `${(await newIdentity()).identity}\n`);
      await chmod(path, 0o440);
      await expect(loadIdentity(config, db)).rejects.toThrow(
        `${path} can be read by other users (mode 440)`,
      );
    }));

  it("prefers the environment's identity and retires the recipient it replaces", () =>
    rolledBack(testPool("worker_rw"), async (db) => {
      const config = await configIn("worker");
      const fromFile = await loadIdentity(config, db);
      const given = await newIdentity();
      const loaded = await loadIdentity(
        { ...config, age_identity: given.identity },
        db,
      );
      expect(loaded.recipient).toBe(given.recipient);
      const rows = await db
        .select()
        .from(container_identity)
        .where(eq(container_identity.container, "worker"));
      const retired = Object.fromEntries(
        rows.map((row) => [row.recipient, row.retired_at !== null]),
      );
      expect(retired).toEqual({
        [fromFile.recipient]: true,
        [given.recipient]: false,
      });
    }));
});
