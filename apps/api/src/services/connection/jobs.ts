import { rm } from "node:fs/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { container_identity } from "../../db/schema/secrets.js";
import { resolveRoles, roleSubject } from "../auth/roles.js";
import { personById } from "../auth/sign-in.js";
import { enqueue } from "../jobs/queue.js";
import { registerJob } from "../jobs/registry.js";
import { readGroups } from "./groups.js";
import {
  endConnection,
  enforceOwnAccount,
  hidingValues,
  lockConnection,
  spendRefreshToken,
} from "./store.js";
import { retiredKeys } from "./vault.js";

/*
 * The two jobs that need the token key, so they run in the api: the worker
 * never holds it.
 */

const DAY_MS = 24 * 60 * 60_000;

/**
 * After rotate-identity, in an api restarted with the new identity: every
 * connection sealed by an identity it retired is opened and sealed again
 * with the vault, and a retired key file is removed once no row is sealed
 * for it. An api not yet restarted holds the old identity in its vault, so
 * it refuses; the restarted one queues the job when it starts.
 */
export async function rekeyTokens(deps: AppDeps): Promise<void> {
  const { vault } = deps;
  const retired = await retiredKeys(deps.config);
  if (retired.length === 0) return;
  // Read only to compare: tokens are sealed with the key in memory, never
  // for a recipient a row in the database names.
  const [published] = await deps.db
    .select({ recipient: container_identity.recipient })
    .from(container_identity)
    .where(
      and(
        eq(container_identity.container, "api"),
        isNull(container_identity.retired_at),
      ),
    );
  if (published?.recipient !== vault.recipient)
    throw new Error("Restart the api, then run rekey_tokens");
  const recipients = retired.map((key) => key.recipient);
  const { sealedAgain, ended, emptied } = await deps.db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(powerbiConnection)
        .where(inArray(powerbiConnection.recipient, recipients))
        .for("update");
      let ended = 0;
      for (const row of rows) {
        const { access_token_ciphertext: access, refresh_token_ciphertext } =
          row;
        // The CHECK constraint keeps both tokens on every row with a recipient.
        if (access === null || refresh_token_ciphertext === null) continue;
        let tokens: [string, string];
        try {
          tokens = [
            await vault.open(access),
            await vault.open(refresh_token_ciphertext),
          ];
        } catch {
          // No key opens it, and none ever will: the person connects again.
          await endConnection(tx, row.user_id, {
            status: "needs_reconnect",
            last_error: "No key of the api opens this connection's tokens.",
          });
          deps.logger.warn("a Power BI connection no key opens was ended", {
            connection_id: row.id,
          });
          ended += 1;
          continue;
        }
        await hidingValues(
          tx
            .update(powerbiConnection)
            .set({
              access_token_ciphertext: await vault.seal(tokens[0]),
              refresh_token_ciphertext: await vault.seal(tokens[1]),
              recipient: vault.recipient,
            })
            .where(eq(powerbiConnection.id, row.id)),
        );
      }
      // A key file stays while any row is still sealed for it.
      const left = await tx
        .select({ recipient: powerbiConnection.recipient })
        .from(powerbiConnection)
        .where(inArray(powerbiConnection.recipient, recipients));
      return {
        sealedAgain: rows.length - ended,
        ended,
        emptied: recipients.filter(
          (recipient) => !left.some((row) => row.recipient === recipient),
        ),
      };
    },
  );
  const removable = retired.filter((key) => emptied.includes(key.recipient));
  for (const { file } of removable) await rm(file);
  deps.logger.info("Power BI tokens sealed for the api's identity", {
    connections: sealedAgain,
    ended,
    retired_keys_removed: removable.length,
  });
}

/** At api start: a retired key on disk may still seal tokens, which this api, holding the new identity, seals again. */
export async function queueRekeyAtStart(deps: AppDeps): Promise<void> {
  if ((await retiredKeys(deps.config)).length > 0)
    await enqueue(deps.db, {
      job: "rekey_tokens",
      runner: "api",
      trigger: "deploy",
    });
}

/**
 * With powerbi.keep_connections_alive_days set, keeps alive every
 * connection whose refresh token has gone unspent that long, so Microsoft's
 * 90 days of inactivity never end it: the person's groups are read through
 * Graph first, which renews their tenant membership only while Microsoft
 * still accepts the account (invalid_grant ends the connection and the
 * membership), then the Power BI token is refreshed for a person a role
 * still reaches. A row that fails is logged and the others go on.
 */
export async function refreshIdleConnections(deps: AppDeps): Promise<void> {
  const days = await deps.settings.get("powerbi.keep_connections_alive_days");
  if (days === null) return;
  const before = new Date(deps.clock().getTime() - days * DAY_MS);
  const { refreshed_at, connected_at } = powerbiConnection;
  const idle = await deps.db
    .select({ user_id: powerbiConnection.user_id })
    .from(powerbiConnection)
    .where(
      and(
        eq(powerbiConnection.status, "connected"),
        sql`coalesce(${refreshed_at}, ${connected_at}) < ${before}`,
      ),
    );
  let failed = 0;
  for (const { user_id } of idle) {
    try {
      // A person no role reaches still has their refresh token renewed by
      // this Graph read, and nothing more.
      await readGroups(deps, user_id);
      const person = await personById(deps.db, user_id);
      const subject = await roleSubject(deps.db, person, deps.clock());
      if ((await resolveRoles(deps, subject)).length === 0) continue;
      await deps.db.transaction(async (tx) => {
        const row = await lockConnection(tx, user_id);
        // Microsoft may have ended it at the Graph read.
        if (
          row?.status === "connected" &&
          (await enforceOwnAccount(deps, tx, row))
        )
          await spendRefreshToken(deps, tx, row, "powerbi");
      });
    } catch (error) {
      failed += 1;
      deps.logger.warn("an idle Power BI connection was not refreshed", {
        user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed > 0)
    throw new Error(
      `${String(failed)} of ${String(idle.length)} idle Power BI connections were not refreshed; the log names each.`,
    );
}

registerJob("rekey_tokens", "api", rekeyTokens);
registerJob("refresh_idle_connections", "api", refreshIdleConnections);
