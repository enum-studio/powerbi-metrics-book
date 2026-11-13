import { rename, rm, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Logger } from "../../log.js";
import { secret_ciphertext } from "../../db/schema/secrets.js";
import { enqueue } from "../jobs/queue.js";
import {
  decryptWith,
  encryptFor,
  generateIdentity,
  recipientOf,
} from "./age.js";
import {
  identityPath,
  identityVariable,
  type LoadedIdentity,
  publishRecipient,
} from "./identities.js";
import type { SecretsDb } from "./store.js";

/**
 * Gives this container a new identity: every secret it reads is decrypted
 * with the old one and encrypted to the new, the new recipient is published
 * and the old one retired, all in one transaction. The old key file is kept
 * as <container>.key.retired-<timestamp> until that transaction commits, and
 * put back when it fails. The api's is kept after that: the running api
 * still seals Power BI tokens with the old identity until it restarts, and
 * rekey_tokens, which the restarted api runs, seals them again and removes
 * the file once no token is sealed for it.
 */
export async function rotateIdentity(deps: {
  config: Config;
  db: SecretsDb;
  clock: () => Date;
  logger: Logger;
  identity: LoadedIdentity;
}): Promise<{
  recipient: string;
  reencrypted: number;
  /** The retired key file, when it could not be removed: it still opens older database backups. */
  left_behind: string | null;
}> {
  const { config, db, clock, logger, identity: old } = deps;
  const container = config.container;
  if (config.age_identity !== null) {
    throw new Error(
      `${identityVariable(container)} sets the ${container}'s identity, and rotate-identity only replaces the file in IDENTITY_DIR.`,
    );
  }
  const identity = await generateIdentity();
  const recipient = await recipientOf(identity);
  const path = identityPath(config);
  const retired = `${path}.retired-${clock().toISOString().replace(/[:.]/g, "-")}`;

  await rename(path, retired);
  let reencrypted: number;
  try {
    await writeFile(path, `${identity}\n`, { mode: 0o400, flag: "wx" });
    reencrypted = await db.transaction(async (tx) => {
      // Published first: a write waiting on the old recipient then sees it retired.
      await publishRecipient(tx, container, recipient);
      // A row encrypted to an identity before the old one was already
      // unreadable; it stays so, and the admin section lists it to enter again.
      const rows = await tx
        .select()
        .from(secret_ciphertext)
        .where(
          and(
            eq(secret_ciphertext.reader, container),
            eq(secret_ciphertext.recipient, old.recipient),
          ),
        )
        .for("update");
      for (const row of rows) {
        const value = await decryptWith(old.identity, row.ciphertext);
        await tx
          .update(secret_ciphertext)
          .set({ recipient, ciphertext: await encryptFor([recipient], value) })
          .where(
            and(
              eq(secret_ciphertext.name, row.name),
              eq(secret_ciphertext.reader, container),
            ),
          );
      }
      if (container === "api")
        await enqueue(tx, {
          job: "rekey_tokens",
          runner: "api",
          trigger: "manual",
        });
      return rows.length;
    });
  } catch (error) {
    await rm(path, { force: true });
    await rename(retired, path);
    throw error;
  }
  // Committed: only the new key opens these secrets now, so nothing that
  // fails from here may touch it.
  if (container === "api") return { recipient, reencrypted, left_behind: null };
  try {
    await rm(retired);
    return { recipient, reencrypted, left_behind: null };
  } catch (error) {
    logger.warn("rotate-identity could not remove the retired key file", {
      path: retired,
      error: String(error),
    });
    return { recipient, reencrypted, left_behind: retired };
  }
}
