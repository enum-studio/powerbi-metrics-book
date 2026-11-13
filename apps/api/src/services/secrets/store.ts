import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  Container,
  SecretName,
  SecretReader,
  SecretWriter,
} from "../../context.js";
import type * as schema from "../../db/schema/index.js";
import {
  container_identity,
  secret,
  secret_ciphertext,
} from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { decryptWith, encryptFor } from "./age.js";
import type { LoadedIdentity } from "./identities.js";
import { FIXED_SECRET_NAMES, readersOf } from "./readers.js";

/*
 * Secrets are write-only. The api encrypts each value once per container that
 * reads it, to that container's recipient alone; only the reader's own
 * identity, which never leaves its volume, opens it. No function here hands a
 * value to anyone but its reader: the writer and list() return none.
 */

/** The app's Db or a transaction in it, so the store's own transactions can nest. */
export type SecretsDb = PgDatabase<NodePgQueryResultHKT, typeof schema>;

type Env = Record<string, string | undefined>;

export function createSecretReader(
  deps: { container: Container; db: SecretsDb; env: Env },
  identity: LoadedIdentity,
): SecretReader {
  const { container, db, env } = deps;
  return {
    async read(name) {
      // Refused before the environment or the database is looked at, so a
      // container never handles a value it is not a reader of.
      if (!readersOf(name).includes(container))
        throw new ServiceError(
          "refused",
          `The ${container} does not read ${name}.`,
        );
      // An environment variable of the same name wins, as for a setting.
      const fromEnv = env[name.toUpperCase()];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      const [row] = await db
        .select()
        .from(secret_ciphertext)
        .where(
          and(
            eq(secret_ciphertext.name, name),
            eq(secret_ciphertext.reader, container),
          ),
        );
      if (row === undefined) return null;
      if (row.recipient !== identity.recipient) {
        throw new ServiceError(
          "conflict",
          `${name} was saved for an earlier identity of the ${container}: enter it again in the admin section.`,
        );
      }
      return decryptWith(identity.identity, row.ciphertext);
    },
  };
}

/** What the admin section shows of a secret: never its value. */
export type SecretListing = {
  name: SecretName;
  readers: readonly Container[];
  set: boolean;
  /**
   * Readers whose current identity cannot open their ciphertext, because it
   * was saved for an identity since replaced (a lost identity volume, or a
   * rotation that could not read it): the admin must enter it again.
   */
  needs_reentry_for: Container[];
  hint: string | null;
  set_by: string | null;
  set_at: Date | null;
  expires_at: Date | null;
  checked_at: Date | null;
  check_status: "passing" | "failing" | "unchecked" | null;
  check_message: string | null;
};

/** What the audit log hears of a write: the name, never the value. */
export type SecretWrite = {
  name: SecretName;
  by: Principal | null;
  at: Date;
  expires_at: Date | null;
};

export interface SecretAdmin extends SecretWriter {
  /** Stores a random value no one sees. */
  generate(name: "result_link_key"): Promise<void>;
  list(): Promise<SecretListing[]>;
}

// Shorter than this, the last four characters would give away too much of the value.
const HINT_MIN_LENGTH = 16;

/** The secrets sent in a request header, which carries Latin-1 only. */
const IN_HEADERS: readonly SecretName[] = ["openai_api_key", "gemini_api_key"];

/**
 * A control character is never part of a real secret, and in a header Node
 * refuses it with an error that quotes the whole value.
 */
function unfit(name: SecretName, value: string): boolean {
  const header = IN_HEADERS.includes(name);
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (header && code > 0xff)
    )
      return true;
  }
  return false;
}

export function createSecretWriter(deps: {
  container: Container;
  db: SecretsDb;
  clock: () => Date;
  onWrite?: (event: SecretWrite) => Promise<void>;
}): SecretAdmin {
  const { container, db, clock, onWrite } = deps;
  if (container !== "api") throw new Error("Only the api writes secrets.");

  async function store(
    name: SecretName,
    value: string,
    by: Principal | null,
    expiresAt: Date | null,
    hint: string | null,
  ): Promise<void> {
    const readers = readersOf(name);
    if (value === "")
      throw new ServiceError("invalid", `${name} cannot be empty.`);
    const at = clock();
    await db.transaction(async (tx) => {
      // For share: a rotation retiring one of these recipients waits for this
      // write, or this write for it, so nothing is encrypted to a retired one.
      const current = await tx
        .select()
        .from(container_identity)
        .where(
          and(
            inArray(container_identity.container, readers),
            isNull(container_identity.retired_at),
          ),
        )
        .for("share");
      const ciphertexts = [];
      for (const reader of readers) {
        const published = current.find((row) => row.container === reader);
        if (published === undefined) {
          throw new ServiceError(
            "conflict",
            `The ${reader} has not started yet: start it, then save ${name} again.`,
          );
        }
        const { recipient } = published;
        ciphertexts.push({
          name,
          reader,
          recipient,
          ciphertext: await encryptFor([recipient], value),
        });
      }
      const row = {
        readers: [...readers],
        hint,
        set_by: by?.id ?? null,
        set_at: at,
        expires_at: expiresAt,
        checked_at: null,
        check_status: "unchecked" as const,
        check_message: null,
      };
      await tx
        .insert(secret)
        .values({ name, ...row })
        .onConflictDoUpdate({ target: secret.name, set: row });
      for (const ciphertext of ciphertexts) {
        await tx
          .insert(secret_ciphertext)
          .values(ciphertext)
          .onConflictDoUpdate({
            target: [secret_ciphertext.name, secret_ciphertext.reader],
            set: {
              recipient: ciphertext.recipient,
              ciphertext: ciphertext.ciphertext,
            },
          });
      }
    });
    await onWrite?.({ name, by, at, expires_at: expiresAt });
  }

  return {
    async write(name, value, by, expiresAt) {
      if (unfit(name, value))
        throw new ServiceError(
          "invalid",
          `${name} holds a line break, a control character or, for an API key, a character a request header cannot carry. Paste the value again.`,
        );
      await store(
        name,
        value,
        by,
        expiresAt,
        value.length >= HINT_MIN_LENGTH ? value.slice(-4) : null,
      );
    },
    async generate(name) {
      // Made by the stack, so set by no one, and never shown, so no hint.
      await store(
        name,
        randomBytes(32).toString("base64url"),
        null,
        null,
        null,
      );
    },
    async list() {
      // One query after another: db may be a transaction, whose one
      // connection runs one query at a time.
      const rows = await db.select().from(secret);
      const ciphertexts = await db
        .select({
          name: secret_ciphertext.name,
          reader: secret_ciphertext.reader,
          recipient: secret_ciphertext.recipient,
        })
        .from(secret_ciphertext);
      const current = await db
        .select()
        .from(container_identity)
        .where(isNull(container_identity.retired_at));
      const opens = (name: SecretName, reader: Container): boolean =>
        ciphertexts.some(
          (row) =>
            row.name === name &&
            row.reader === reader &&
            current.some(
              (identity) =>
                identity.container === reader &&
                identity.recipient === row.recipient,
            ),
        );
      const names = new Set([
        ...FIXED_SECRET_NAMES,
        ...rows.map((row) => row.name),
      ]);
      return [...names].sort().map((name) => {
        const row = rows.find((candidate) => candidate.name === name);
        const readers = readersOf(name);
        return {
          name,
          readers,
          set: row !== undefined,
          needs_reentry_for:
            row === undefined
              ? []
              : readers.filter((reader) => !opens(name, reader)),
          hint: row?.hint ?? null,
          set_by: row?.set_by ?? null,
          set_at: row?.set_at ?? null,
          expires_at: row?.expires_at ?? null,
          checked_at: row?.checked_at ?? null,
          check_status: row?.check_status ?? null,
          check_message: row?.check_message ?? null,
        };
      });
    },
  };
}
