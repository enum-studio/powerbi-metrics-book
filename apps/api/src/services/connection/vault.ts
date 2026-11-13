import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Config } from "../../config.js";
import type { Vault } from "../../context.js";
import { decryptWith, encryptFor, recipientOf } from "../secrets/age.js";
import {
  identityPath,
  type LoadedIdentity,
  readIdentityFile,
} from "../secrets/identities.js";

/** A key file rotate-identity retired and left on disk, by its recipient. */
export type RetiredKey = { file: string; recipient: string };

async function retiredOnDisk(
  config: Config,
): Promise<(RetiredKey & { identity: string })[]> {
  // An identity from the environment is never rotated, so none was retired.
  if (config.age_identity !== null) return [];
  const path = identityPath(config);
  const prefix = `${basename(path)}.retired-`;
  const names = await readdir(dirname(path));
  return Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const file = join(dirname(path), name);
        const identity = await readIdentityFile(file);
        return { file, identity, recipient: await recipientOf(identity) };
      }),
  );
}

/** The retired key files, for rekey_tokens: their recipients, never their keys. */
export async function retiredKeys(config: Config): Promise<RetiredKey[]> {
  return (await retiredOnDisk(config)).map(({ file, recipient }) => ({
    file,
    recipient,
  }));
}

/**
 * This container's identity as a capability, built once at start: services
 * seal and open with it and never hold the key. The identities
 * rotate-identity retired are read from disk only when the current one
 * cannot open a ciphertext.
 */
export function createVault(config: Config, current: LoadedIdentity): Vault {
  return {
    recipient: current.recipient,
    seal: (text) => encryptFor([current.recipient], text),
    async open(ciphertext) {
      try {
        return await decryptWith(current.identity, ciphertext);
      } catch (error) {
        // Sealed before a rotation, by an identity still on disk.
        for (const { identity } of await retiredOnDisk(config)) {
          try {
            return await decryptWith(identity, ciphertext);
          } catch {
            // Not this one: the next retired identity may open it.
          }
        }
        throw error;
      }
    },
  };
}
