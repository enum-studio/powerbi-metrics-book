import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Container } from "../../context.js";
import { container_identity } from "../../db/schema/secrets.js";
import { generateIdentity, recipientOf } from "./age.js";
import type { SecretsDb } from "./store.js";

/** A container's age identity (private) and its recipient (public). Never logged, never returned by a route. */
export type LoadedIdentity = { identity: string; recipient: string };

const IDENTITY_PREFIX = "AGE-SECRET-KEY-1";

export function identityVariable(container: Container): string {
  return container === "api" ? "API_AGE_IDENTITY" : "WORKER_AGE_IDENTITY";
}

export function identityPath(config: Config): string {
  return join(config.identity_dir, `${config.container}.key`);
}

/**
 * This container's identity: API_AGE_IDENTITY or WORKER_AGE_IDENTITY when
 * set, else <IDENTITY_DIR>/<container>.key, made on first start. Then the
 * recipient is published, so the api can encrypt for this container.
 */
export async function loadIdentity(
  config: Config,
  db: SecretsDb,
): Promise<LoadedIdentity> {
  const identity =
    config.age_identity ??
    (await readOrCreateIdentityFile(identityPath(config)));
  const loaded = { identity, recipient: await recipientOf(identity) };
  await publishRecipient(db, config.container, loaded.recipient);
  return loaded;
}

async function readOrCreateIdentityFile(path: string): Promise<string> {
  try {
    return await readIdentityFile(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const created = await generateIdentity();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // wx never overwrites: of two replicas starting at once, the first file wins.
    await writeFile(path, `${created}\n`, { mode: 0o400, flag: "wx" });
    return created;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  return readIdentityFile(path);
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** The error names the file and never repeats what is in it. */
export async function readIdentityFile(path: string): Promise<string> {
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users (mode ${(mode & 0o777).toString(8)}): make it readable by its owner only, chmod 400`,
    );
  }
  const identity = (await readFile(path, "utf8")).trim();
  if (!identity.startsWith(IDENTITY_PREFIX) || /\s/.test(identity))
    throw new Error(
      `${path} does not hold one age identity, ${IDENTITY_PREFIX}...`,
    );
  return identity;
}

/**
 * Makes recipient the container's current one: a new recipient is inserted
 * and the one it replaces gets retired_at. The retire runs first, so the
 * index allowing one current row per container never sees two.
 */
export async function publishRecipient(
  db: SecretsDb,
  container: Container,
  recipient: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(container_identity)
      .set({ retired_at: sql`now()` })
      .where(
        and(
          eq(container_identity.container, container),
          isNull(container_identity.retired_at),
          ne(container_identity.recipient, recipient),
        ),
      );
    await tx
      .insert(container_identity)
      .values({ container, recipient })
      .onConflictDoUpdate({
        target: [container_identity.container, container_identity.recipient],
        set: { retired_at: null },
      });
  });
}
