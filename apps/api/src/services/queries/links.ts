import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import { queryResult } from "../../db/schema/queries.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { looksLikeId } from "../mirror/read.js";
import { createSecretWriter } from "../secrets/store.js";

/*
 * A CSV link lets an agent download a result straight to a file, so the rows
 * never pass through the model. It is an HMAC-SHA256 signature over the
 * result id, its owner and an expiry 15 minutes ahead, under result_link_key,
 * which only the api reads.
 */

const LINK_TTL_MS = 15 * 60_000;
const KEY_LOCK = "powerbi_metrics_book.result_link_key";

export type LinkDeps = Pick<
  AppDeps,
  "container" | "db" | "clock" | "config" | "secrets"
>;
export type ResultOwner = Pick<Principal, "kind" | "id">;
export type SignedResult = {
  id: string;
  owner_kind: ResultOwner["kind"];
  owner_id: string;
};
export type CsvLink = { csv_url: string; csv_url_expires_at: string };

/** The key, made on first use and never shown to anyone. */
async function linkKey(deps: LinkDeps): Promise<string> {
  const key = await deps.secrets.read("result_link_key");
  if (key !== null) return key;
  await deps.db.transaction(async (tx) => {
    // Two first uses at once would store two keys, and the links signed with the first would stop verifying.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${KEY_LOCK}, 0))`,
    );
    if ((await deps.secrets.read("result_link_key")) !== null) return;
    const writer = createSecretWriter({
      container: deps.container,
      db: tx,
      clock: deps.clock,
    });
    await writer.generate("result_link_key");
  });
  const made = await deps.secrets.read("result_link_key");
  if (made === null)
    throw new Error("result_link_key was stored and reads as missing");
  return made;
}

function sign(key: string, result: SignedResult, expires: number): Buffer {
  return createHmac("sha256", key)
    .update(
      [result.id, result.owner_kind, result.owner_id, String(expires)].join(
        "\n",
      ),
    )
    .digest();
}

export async function csvLink(
  deps: LinkDeps,
  result: SignedResult,
): Promise<CsvLink> {
  const expires = Math.floor((deps.clock().getTime() + LINK_TTL_MS) / 1000);
  const signature = sign(await linkKey(deps), result, expires);
  const url = new URL(
    `api/v1/results/${result.id}/csv`,
    deps.config.public_base_url.href.replace(/\/?$/, "/"),
  );
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature.toString("base64url"));
  return {
    csv_url: url.href,
    csv_url_expires_at: new Date(expires * 1000).toISOString(),
  };
}

/** What every link that cannot be used is refused with; `detail` is for the audit, never the answer. */
export const invalidLink = (detail: Record<string, unknown> = {}) =>
  new ServiceError(
    "refused",
    "This CSV link is not valid. Ask for a fresh one with get_result_csv_link.",
    detail,
  );

/**
 * The owner the link was signed for, when the signature matches the result
 * as stored and the link has not expired. Any other link is refused alike,
 * so a refusal tells nothing about whether the result exists.
 */
export async function verifyCsvLink(
  deps: LinkDeps,
  id: string,
  expires: string,
  signature: string,
): Promise<ResultOwner> {
  const invalid = invalidLink();
  if (!/^\d{1,12}$/.test(expires) || !looksLikeId(id)) throw invalid;
  if (Number(expires) * 1000 <= deps.clock().getTime())
    throw new ServiceError(
      "refused",
      "This CSV link expired. Ask for a fresh one with get_result_csv_link.",
    );
  const [row] = await deps.db
    .select({
      owner_kind: queryResult.owner_kind,
      owner_id: queryResult.owner_id,
    })
    .from(queryResult)
    .where(eq(queryResult.id, id));
  if (row === undefined) throw invalid;
  const expected = sign(await linkKey(deps), { id, ...row }, Number(expires));
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw invalid;
  return { kind: row.owner_kind, id: row.owner_id };
}
