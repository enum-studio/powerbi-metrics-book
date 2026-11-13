import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps, ServiceContext } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { serviceAccount } from "../../db/schema/service-accounts.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { writeAudit } from "../audit/write.js";
import { personPrincipal } from "../auth/principal.js";
import { clientAddressKey } from "../auth/client-address-key.js";
import { usableFrom } from "../auth/service-accounts.js";
import { countRequest, type RateRule } from "../rate-limit.js";
import { type CsvAccess, resultCsv } from "./csv.js";
import { invalidLink, type ResultOwner, verifyCsvLink } from "./links.js";

/*
 * Who may download a result as CSV, and how that is recorded. The route is
 * public for a signed link, so this module judges the request itself: the
 * link, or the caller's own credential when no link comes. A request with
 * both is judged by the link, and the credential must name its owner.
 */

/** Per address: a link is a bearer credential on a public path, so this bounds guessing and a leaked link's reuse. */
const LINK_RATE: RateRule = { window_seconds: 60, max: 60 };
/** Per owner, whether by credential or by link: a result can be 100,000 rows, so half a link's allowance per address. */
const CREDENTIAL_RATE: RateRule = { window_seconds: 60, max: 30 };
/**
 * Cerbos wants every principal to hold a role. The holder of a link has none
 * of its own, and the result policy lets the owner of any role read.
 */
const LINK_ROLE = "csv_link";

export type CsvRequest = {
  result: string;
  link: { expires?: string; signature?: string };
  /** The caller's own credential, when it sent one (already refused if no role reaches it). */
  credential: Principal | undefined;
  /** Where the request came from, read as sign-in reads it. */
  address: string | null;
};

async function limit(
  deps: AppDeps,
  key: string,
  rule: RateRule,
  what: string,
): Promise<void> {
  const verdict = await countRequest(deps.db, key, rule, deps.clock());
  if (!verdict.allowed)
    throw new ServiceError(
      "rate_limited",
      `Too many ${what}. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
    );
}

/** The CSV as a stream, after its first line: the owner check and the audit have run before a byte is sent. */
async function csvStream(
  lines: AsyncIterable<string>,
): Promise<ReadableStream<Uint8Array>> {
  const rows = lines[Symbol.asyncIterator]();
  let next = await rows.next();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
      next = await rows.next();
    },
    async cancel() {
      await rows.return?.();
    },
  });
}

/** A refusal is audited when a principal is known; the reason is the error's kind. */
async function deny(
  deps: AppDeps,
  principal: Principal,
  result: string,
  access: CsvAccess & { link_owner?: ResultOwner },
  error: unknown,
): Promise<void> {
  if (error instanceof ServiceError)
    await writeAudit(deps, {
      principal,
      action: "result.download",
      resource: { kind: "result", id: result },
      decision: "deny",
      reason: error.kind,
      detail: { ...access, ...error.detail },
    });
}

/** A link holder is still its owner: a person no role reaches, or a service account that is disabled, gone or off its addresses, gets nothing. */
async function ownerStands(
  deps: AppDeps,
  owner: ResultOwner,
  address: string | null,
): Promise<void> {
  // The holder is refused as for a link to a result that is gone; the audit row says why.
  const missing = (why: string) => invalidLink({ why });
  if (owner.kind === "person") {
    const [person] = await deps.db
      .select({
        id: user.id,
        email: user.email,
        email_verified: user.emailVerified,
      })
      .from(user)
      .where(eq(user.id, owner.id));
    if (person === undefined) throw missing("no_such_person");
    const now = await personPrincipal(deps, person, {
      via: "api",
      client_id: null,
    });
    if (now.roles.length === 0) throw missing("no_role");
    return;
  }
  const [account] = await deps.db
    .select({ roles: serviceAccount.roles })
    .from(serviceAccount)
    .where(
      and(
        eq(serviceAccount.name, owner.id),
        isNull(serviceAccount.disabled_at),
        usableFrom(address),
      ),
    );
  if (account === undefined || account.roles.length === 0)
    throw missing("account_unavailable");
}

async function serve(
  context: ServiceContext,
  result: string,
  access: CsvAccess,
  before: () => Promise<void> = () => Promise.resolve(),
): Promise<ReadableStream<Uint8Array>> {
  try {
    await before();
    return await csvStream(resultCsv(context, result, access));
  } catch (error) {
    await deny(context, context.principal, result, access, error);
    throw error;
  }
}

/** One budget per owner, whether the download comes by credential or by link. */
const ownerLimit = (deps: AppDeps, owner: ResultOwner) =>
  limit(
    deps,
    `csv:${owner.kind}:${owner.id}`,
    CREDENTIAL_RATE,
    "downloads of this owner's results",
  );

export async function downloadCsv(
  deps: AppDeps,
  { result, link, credential, address }: CsvRequest,
): Promise<ReadableStream<Uint8Array>> {
  const viaLink =
    link.expires !== undefined ||
    link.signature !== undefined ||
    credential === undefined;
  if (!viaLink) {
    await ownerLimit(deps, credential);
    return serve({ ...deps, principal: credential }, result, {
      by: "credential",
    });
  }
  const access: CsvAccess = { by: "csv_link", address };
  await limit(
    deps,
    `csv_link:${address === null ? "unknown" : clientAddressKey(address)}`,
    LINK_RATE,
    "downloads from this address",
  );
  let owner: ResultOwner;
  try {
    owner = await verifyCsvLink(
      deps,
      result,
      link.expires ?? "",
      link.signature ?? "",
    );
  } catch (error) {
    // With no credential there is no principal to record; the address limit bounds it.
    if (credential !== undefined)
      await deny(deps, credential, result, access, error);
    throw error;
  }
  if (
    credential !== undefined &&
    (credential.kind !== owner.kind || credential.id !== owner.id)
  ) {
    // Someone else's link: recorded as the one who presented it.
    const missing = new ServiceError("not_found", "No such result.");
    await deny(
      deps,
      credential,
      result,
      { ...access, link_owner: owner },
      missing,
    );
    throw missing;
  }
  await ownerLimit(deps, owner);
  const holder: Principal = {
    ...owner,
    roles: [LINK_ROLE],
    attributes: {
      powerbi_workspace_ids: [],
      powerbi_app_ids: [],
      powerbi_dataset_ids: [],
    },
    via: "api",
    client_id: null,
  };
  return serve({ ...deps, principal: holder }, result, access, () =>
    ownerStands(deps, owner, address),
  );
}
