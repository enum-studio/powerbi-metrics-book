import { stat } from "node:fs/promises";
import { z } from "zod";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  ne,
} from "drizzle-orm";
import type { AppDeps } from "../../context.js";
import type { Principal } from "../../principal.js";
import { settingCheck } from "../../db/schema/admin.js";
import { auditEvent } from "../../db/schema/audit.js";
import { user } from "../../db/schema/auth.js";
import { powerbiConnection } from "../../db/schema/connection.js";
import { metric } from "../../db/schema/book.js";
import { jobRequest } from "../../db/schema/jobs.js";
import {
  powerbiDataset,
  powerbiMeasure,
  syncRun,
} from "../../db/schema/mirror.js";
import { EMBEDDED_KINDS } from "../../db/schema/search.js";
import { secret, secret_ciphertext } from "../../db/schema/secrets.js";
import { ServiceError } from "../../errors.js";
import { appServicePrincipalToken } from "../../powerbi/identity.js";
import type { CheckResult } from "../admin/checks.js";
import { assignmentDetail, listRoleAssignments } from "../admin/people.js";
import { secretInWords } from "../admin/secret-words.js";
import {
  permissionNote,
  permissionProblem,
  rolesProblem,
} from "./app-registration-check.js";
import { collectDocuments } from "../search/documents.js";
import {
  costMicroUsd,
  createEmbedder,
  type Embedder,
  EMBEDDING_PROBE_SENTENCE,
  type EmbeddingFailureCode,
  estimateTokens,
  failureCode,
} from "../search/embedder.js";
import { resolveRoles, roleSubject } from "../auth/roles.js";
import { CONNECTOR_REACHED_ACTION } from "../audit/connector.js";
import { adminExists } from "./link.js";

/*
 * Each step's check: a real call or a read of what the stack holds, and a
 * fixed sentence for each known failure, never text from upstream. A
 * passing check may say what it found.
 */

export const AddressDetails = z.object({
  public_base_url: z.string(),
  cookies_secure: z.boolean(),
});

export const WorkspaceDetails = z.object({
  workspaces: z
    .array(
      z.object({
        id: z.guid(),
        name: z.string().max(256),
        personal: z.boolean(),
      }),
    )
    .max(1000),
  truncated: z.boolean(),
  personal_count: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Personal workspaces in the listed set before trimming; a lower bound when truncated.",
    ),
});

type StepDetails =
  | z.infer<typeof WorkspaceDetails>
  | { reason: "tenant_settings" }
  | { public_base_url: string; cookies_secure: boolean }
  | { providers: string[] }
  | {
      default_role: string;
      assignments?: ReturnType<typeof assignmentDetail>[];
    }
  | { provider: "none" }
  | {
      provider: "openai" | "gemini";
      model: string;
      documents: number;
      estimated_tokens: number;
      cost_micro_usd: number;
    }
  | { mcp_url: string; cli_install: string; cli_login: string }
  | { measures: number; datasets: number; drafts: number }
  | { items: Item[] };

export type StepResult = Omit<CheckResult, "details"> & {
  details?: StepDetails;
  /** The person the setup's sign-in admitted, to confirm as the first admin. */
  confirm?: { email: string; name: string };
  /** What the browser does next: Microsoft's sign-in, or the Power BI connection. */
  action?: "sign_in" | "connect";
  /** It waits on the worker (a sync, a check only the worker can run): ask the step again, which starts nothing. */
  pending?: true;
};

/** What the request running a step tells its check; null from /admin's re-run. */
export type StepRequest = {
  /** Who runs the step; null when /admin's daily check job does. */
  principal: Principal | null;
  person_id: string | null;
  host: string | null;
};
export type StepCheck = (
  deps: AppDeps,
  request: StepRequest,
) => Promise<StepResult>;

export const pass = (
  message: string | null = null,
  details?: StepDetails,
): StepResult => ({
  status: "passing",
  message,
  ...(details === undefined ? {} : { details }),
});
export const fail = (
  message: string,
  more: Omit<StepResult, "status" | "message"> = {},
): StepResult => ({
  status: "failing",
  message,
  ...more,
});

const developmentOrTest = (deps: AppDeps) =>
  ["development", "test"].includes(deps.config.node_env);
const CLIENT_REFUSED = ["invalid_client", "unauthorized_client"];

/** The sentence for a refused client-credentials token, for either registration. */
export function tokenRefusal(error: unknown, registration: string): string {
  if (!(error instanceof ServiceError)) throw error;
  if (
    typeof error.detail.message === "string" &&
    /\bAADSTS7000222\b/.test(error.detail.message)
  )
    return "The client secret has expired: make a new one in Certificates & secrets and enter it here.";
  if (CLIENT_REFUSED.includes(String(error.detail.code)))
    return `Microsoft refused the ${registration}'s client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.`;
  if (error.kind === "conflict")
    return `Enter the ${registration}'s client id and secret first.`;
  return `Microsoft gave the ${registration} no token. Check the tenant id: it is the Directory (tenant) ID on the registration's Overview page.`;
}

export const address: StepCheck = (deps, { host }) => {
  const url = deps.config.public_base_url;
  if (url.protocol !== "https:" && !developmentOrTest(deps))
    return Promise.resolve(
      fail(
        "PUBLIC_BASE_URL is not https. Serve the api over https at the proxy, then set PUBLIC_BASE_URL to that https address.",
      ),
    );
  if (host !== null && host !== url.host)
    return Promise.resolve(
      fail(
        `This page came in at another address than PUBLIC_BASE_URL, ${url.origin}. Open the setup at that address, or set PUBLIC_BASE_URL to the one people use.`,
      ),
    );
  // Better Auth's cookies and the setup's are always Secure (better-auth.ts).
  return Promise.resolve(
    pass(null, { public_base_url: url.origin, cookies_secure: true }),
  );
};

/** The scopes of one person's connection, or of every connection; null when there is none. */
async function connectedScopes(
  deps: AppDeps,
  personId: string | null,
): Promise<string[] | null> {
  const rows = await deps.db
    .select({ scopes: powerbiConnection.scopes })
    .from(powerbiConnection)
    .where(
      and(
        eq(powerbiConnection.status, "connected"),
        personId === null ? undefined : eq(powerbiConnection.user_id, personId),
      ),
    );
  return rows.length === 0 ? null : rows.flatMap((row) => row.scopes);
}

export const appRegistration: StepCheck = async (deps, { person_id }) => {
  let token: string;
  try {
    token = await appServicePrincipalToken(deps);
  } catch (error) {
    return fail(tokenRefusal(error, "app registration"));
  }
  const roles = rolesProblem(token, "app");
  if (roles !== null) return fail(roles);
  if (!(await adminExists(deps.db)))
    return fail(
      "The app registration works. Sign in with Microsoft now: you become the first admin.",
      {
        action: "sign_in",
      },
    );
  const scopes = await connectedScopes(deps, person_id);
  if (scopes === null)
    return fail(
      "Connect Power BI now, so the check can read what your token allows.",
      { action: "connect" },
    );
  const problem = permissionProblem(scopes);
  if (problem !== null) return fail(problem);
  return pass(
    permissionNote(scopes, token, {
      service_account_queries: await deps.settings.get(
        "powerbi.service_account_queries",
      ),
    }),
  );
};

/** An OpenID Connect provider answers its discovery document for its own issuer. */
async function discovers(deps: AppDeps, issuer: string): Promise<boolean> {
  try {
    const response = await deps.fetcher.fetchUntrusted(
      `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      { headers: { accept: "application/json" } },
    );
    const document = response.ok
      ? ((await response.json()) as { issuer?: unknown })
      : null;
    return document?.issuer === issuer;
  } catch (error) {
    deps.logger.warn("a sign-in provider's discovery failed in its check", {
      error: String(error),
    });
    return false;
  }
}

export const signIn: StepCheck = async (deps) => {
  const providers = await deps.settings.get("sign_in.providers");
  for (const provider of providers) {
    if (
      (await deps.secrets.read(`sign_in_${provider.id}_client_secret`)) === null
    )
      return fail(
        `Enter the client secret of the sign-in provider ${provider.id}.`,
      );
    if (
      provider.kind === "oidc" &&
      !(provider.issuer !== null && (await discovers(deps, provider.issuer)))
    )
      return fail(
        `The provider ${provider.id} has no discovery document at its issuer. Check the issuer URL: it ends before /.well-known.`,
      );
  }
  return pass(null, {
    providers: ["microsoft", ...providers.map((provider) => provider.id)],
  });
};

export const whoGetsIn: StepCheck = async (deps, { principal }) => {
  const default_role = await deps.settings.get("access.default_role");
  const sentence =
    default_role === "none"
      ? "Only the people, domains and groups assigned a role get in."
      : `Everyone in the tenant gets in as ${default_role}, and the people, domains and groups assigned a role get it.`;
  // The list sits behind manage_people, as in /admin.
  if (principal === null) return pass(sentence, { default_role });
  const assignments = await listRoleAssignments({ ...deps, principal });
  return pass(sentence, {
    default_role,
    assignments: assignments.map(assignmentDetail),
  });
};

/** By the code of the ServiceError the embedder threw, never by the provider's own words. */
const EMBEDDING_FAILURES = {
  key_missing:
    "Enter the API key of the provider you chose, then run the check again.",
  key_refused:
    "The provider refused the API key. Paste the key again, and check that it belongs to the provider you chose.",
  rate_limited:
    "The provider is rate limiting this key. Wait a few minutes and run the check again.",
  provider_failed:
    "The provider failed on its side. Run the check again in a few minutes.",
  request_refused:
    "The provider refused the request. Check the model name and the address, and that the key is for this provider.",
  bad_answer:
    "The provider answered in a shape this version does not know. Check the model name and the address.",
} satisfies Record<EmbeddingFailureCode, string>;

const dollars = (microUsd: number) =>
  `$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;

export const search: StepCheck = async (deps) => {
  let embedder: Embedder | null;
  try {
    embedder = await createEmbedder(deps);
    await embedder?.embed([EMBEDDING_PROBE_SENTENCE], "query");
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    const code = failureCode(error);
    return fail(
      code === null
        ? "The provider could not be reached. Check the address and that this server can reach it."
        : EMBEDDING_FAILURES[code],
    );
  }
  if (embedder === null)
    return pass("Search is off: agents find metrics by name and by filters.", {
      provider: "none",
    });
  const embedded = new Set<string>(EMBEDDED_KINDS);
  const documents = (await collectDocuments(deps.db)).filter((document) =>
    embedded.has(document.kind),
  );
  const tokens = documents.reduce(
    (sum, document) => sum + estimateTokens(document.search_text),
    0,
  );
  const cost = costMicroUsd(embedder.provider, tokens);
  return pass(
    `One sentence was embedded with ${embedder.provider} ${embedder.model}. Embedding the book as it stands, ${String(documents.length)} documents, would cost about ${dollars(cost)}.`,
    {
      provider: embedder.provider,
      model: embedder.model,
      documents: documents.length,
      estimated_tokens: tokens,
      cost_micro_usd: cost,
    },
  );
};

export const agents: StepCheck = async (deps) => {
  const base = deps.config.public_base_url.origin;
  const details = {
    mcp_url: `${base}/api/mcp`,
    cli_install: "uv tool install powerbi-metrics-book",
    cli_login: `pbmb login --url ${base}`,
  };
  // An admin's own client has reached the connector: it called whoami, which audits the call.
  // Admin is the role they hold now, by their email, a group or the tenant, as resolveRoles reads it.
  // Callers newest call first, a page at a time until one holds the admin role. Callers
  // joining or leaving between pages can only make the check miss one, never pass wrongly.
  const PAGE = 50;
  const lastCall = max(auditEvent.at);
  let admin = false;
  for (let offset = 0; !admin; offset += PAGE) {
    const callers = await deps.db
      .select({
        id: user.id,
        email: user.email,
        email_verified: user.emailVerified,
      })
      .from(auditEvent)
      .innerJoin(user, eq(user.id, auditEvent.principal_id))
      .where(
        and(
          eq(auditEvent.action, CONNECTOR_REACHED_ACTION),
          eq(auditEvent.principal_kind, "person"),
          eq(auditEvent.via, "mcp"),
        ),
      )
      .groupBy(user.id)
      .orderBy(desc(lastCall), asc(user.id))
      .limit(PAGE)
      .offset(offset);
    for (const person of callers) {
      const subject = await roleSubject(deps.db, person, deps.clock());
      if ((await resolveRoles(deps, subject)).includes("admin")) {
        admin = true;
        break;
      }
    }
    if (callers.length < PAGE) break;
  }
  return !admin
    ? fail(
        "No agent of yours has signed in to the connector yet. Add the MCP address to Claude, Codex or Cursor, then ask it to run whoami.",
        { details },
      )
    : pass(null, details);
};

export const NO_SYNC_YET =
  "No sync has run yet. Start the first sync on this step.";

export const firstSync: StepCheck = async (deps) => {
  const [run] = await deps.db
    .select()
    .from(syncRun)
    .where(ne(syncRun.status, "skipped"))
    .orderBy(desc(syncRun.started_at))
    .limit(1);
  if (run?.status === "running")
    return fail(
      `The first sync is running: ${String(run.workspaces_scanned)} workspaces scanned so far.`,
      { pending: true },
    );
  if (run?.status !== "succeeded") {
    // A sync asked for after a failure reports as waiting, not as the failure
    // before it, also once the worker has taken it and not yet recorded its run.
    const [asked] = await deps.db
      .select({ id: jobRequest.id })
      .from(jobRequest)
      .where(
        and(
          eq(jobRequest.job, "sync"),
          inArray(jobRequest.status, ["queued", "running"]),
        ),
      );
    if (asked !== undefined)
      return fail(
        "The first sync waits for the worker to start it. Check that the worker container is running.",
        { pending: true },
      );
    return fail(
      run === undefined
        ? NO_SYNC_YET
        : "The last sync failed. pbmb sync status says what it could not read or store, and why: fix that, then start the sync again.",
    );
  }
  const [[datasets], [measures], [drafts]] = await Promise.all([
    deps.db
      .select({ n: count() })
      .from(powerbiDataset)
      .where(isNull(powerbiDataset.removed_at)),
    deps.db
      .select({ n: count() })
      .from(powerbiMeasure)
      .where(isNull(powerbiMeasure.removed_at)),
    deps.db
      .select({ n: count() })
      .from(metric)
      .where(eq(metric.trust_state, "draft")),
  ]);
  const found = {
    measures: measures?.n ?? 0,
    datasets: datasets?.n ?? 0,
    drafts: drafts?.n ?? 0,
  };
  return pass(
    `${String(found.measures)} measures in ${String(found.datasets)} datasets, ${String(found.drafts)} drafts ready for your agent.`,
    found,
  );
};

type Item = {
  item: string;
  status: "passing" | "failing" | "explained";
  sentence: string;
};

async function scannerSecretItem(deps: AppDeps): Promise<Item> {
  const name = "powerbi_scanner_client_secret";
  const readers = await deps.db
    .select({ reader: secret_ciphertext.reader })
    .from(secret_ciphertext)
    .where(eq(secret_ciphertext.name, name));
  const item = "scanner_secret_worker_only";
  if (readers.length === 0)
    return {
      item,
      status: "explained",
      sentence: "The scanner's secret is not set yet.",
    };
  return readers.every((row) => row.reader === "worker")
    ? {
        item,
        status: "passing",
        sentence: "Only the worker can read the scanner's secret.",
      }
    : {
        item,
        status: "failing",
        sentence:
          "The api can read the scanner's secret. Enter it again, so it is encrypted for the worker only.",
      };
}

async function expiryItems(deps: AppDeps): Promise<Item[]> {
  const rows = await deps.db
    .select({ name: secret.name, expires_at: secret.expires_at })
    .from(secret);
  // Entra's and the sign-in providers' secrets expire; the stack's own and the embedding keys need not.
  return rows
    .filter((row) => /^(powerbi_|sign_in_)/.test(row.name))
    .map((row) => ({
      item: `expiry_${row.name}`,
      ...(row.expires_at === null
        ? {
            status: "failing" as const,
            sentence: `${secretInWords(row.name)} has no expiry date. Enter the date Entra shows, so you are warned before it expires.`,
          }
        : {
            status: "passing" as const,
            sentence: `${secretInWords(row.name)} has its expiry date.`,
          }),
    }));
}

async function identityItem(deps: AppDeps): Promise<Item> {
  const item = "identity_volume_private";
  if (deps.config.age_identity !== null)
    return {
      item,
      status: "explained",
      sentence:
        "The api's identity comes from API_AGE_IDENTITY, so no volume holds it.",
    };
  const found = await stat(deps.config.identity_dir).catch(
    (error: unknown) => ({
      code:
        error instanceof Error && "code" in error
          ? String(error.code)
          : "unknown",
    }),
  );
  if ("code" in found) {
    if (found.code === "ENOENT")
      return {
        item,
        status: "failing",
        sentence:
          "IDENTITY_DIR does not exist in the api, so its identity is not kept on a volume.",
      };
    // The status page reads this item on every look, so the fault stays this item's.
    deps.logger.warn("IDENTITY_DIR could not be read in its check", {
      code: found.code,
    });
    return {
      item,
      status: "failing",
      sentence:
        "The api could not read IDENTITY_DIR, so it cannot say who else can. The api's log has the reason.",
    };
  }
  return (found.mode & 0o077) === 0
    ? {
        item,
        status: "passing",
        sentence: "Only the api's own user can read its identity volume.",
      }
    : {
        item,
        status: "failing",
        sentence:
          "Other users can read the api's identity volume. Run chmod 700 on it.",
      };
}

/** The security checklist as it stands now. It reads and stores nothing else, so a page may ask for it on every load. */
export async function securityItems(deps: AppDeps): Promise<Item[]> {
  const https = deps.config.public_base_url.protocol === "https:";
  const [appCheck] = await deps.db
    .select()
    .from(settingCheck)
    .where(eq(settingCheck.key, "app_registration"));
  return [
    https
      ? {
          item: "https",
          status: "passing",
          sentence: "PUBLIC_BASE_URL is https.",
        }
      : developmentOrTest(deps)
        ? {
            item: "https",
            status: "explained",
            sentence:
              "PUBLIC_BASE_URL is http, which only development and test allow.",
          }
        : {
            item: "https",
            status: "failing",
            sentence:
              "PUBLIC_BASE_URL is not https. Serve the api over https at the proxy.",
          },
    {
      item: "cookies_secure",
      status: "passing",
      sentence: "Cookies are Secure, HttpOnly and SameSite=Lax.",
    },
    await scannerSecretItem(deps),
    appCheck?.status === "passing"
      ? // A passing check speaks only to name what the app holds beyond the minimum.
        appCheck.message === null
        ? {
            item: "app_registration_read_only",
            status: "passing",
            sentence:
              "The app registration holds nothing extra for Power BI. This check reads no other resource, such as Microsoft Graph.",
          }
        : {
            item: "app_registration_read_only",
            status: "explained",
            sentence:
              "The app registration holds more for Power BI than this app needs, and that may include a permission that writes. The note on its check says what it could read. This check reads no other resource, such as Microsoft Graph.",
          }
      : {
          item: "app_registration_read_only",
          status: "failing",
          sentence:
            "The app registration's check has not passed. Finish the app registration step first.",
        },
    ...(await expiryItems(deps)),
    await identityItem(deps),
    {
      item: "worker_identity_volume_private",
      status: "explained",
      sentence:
        "The api cannot see the worker's volume. In the worker, ls -ld /var/lib/pbmb/identity should show drwx------.",
    },
  ];
}

export const security: StepCheck = async (deps) => {
  const items = await securityItems(deps);
  const failing = items.filter((each) => each.status === "failing").length;
  return failing === 0
    ? pass(null, { items })
    : fail(
        `${String(failing)} of the security checklist's items fail. Each says what to change.`,
        { details: { items } },
      );
};
