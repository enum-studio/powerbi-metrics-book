import { randomUUID } from "node:crypto";
import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
} from "@better-auth/oauth-provider";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps, Db } from "../../context.js";
import {
  deviceCode,
  deviceRequest as deviceRequestTable,
  oauthClient,
  oauthClientResource,
  oauthConsent,
} from "../../db/schema/auth.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import type { Auth } from "./better-auth.js";
import { CLI_CLIENT_ID } from "./grants.js";
import {
  askAsPerson,
  baseOf,
  type Caller,
  NOT_A_FORM,
  OFFLINE_ACCESS,
  oauthError,
  RESOURCE_SCOPES,
  readForm,
  repeatsAField,
  resourceUri,
} from "./oauth.js";

/*
 * `pbmb login`: RFC 8628's device flow, for the CLI's own client only. Better
 * Auth's oauthDeviceAuthorization serves the device grant at the OAuth
 * provider's token endpoint (@better-auth/oauth-provider dist/index.mjs,
 * exchangeOAuthDeviceCode), so the CLI gets an access and a refresh token
 * like any MCP client, never a session token.
 */

const CLI_SCOPES = [RESOURCE_SCOPES.v1, OFFLINE_ACCESS];
/** Starting `pbmb login` ten times a minute from one address is already a script. */
export const DEVICE_CODE_RULE = { window: 60, max: 10 };
/** Answering a code is as strict as Better Auth's own lookup on /device: 5 per code lifetime per address. */
export const DEVICE_ANSWER_RULE = { window: 600, max: 5 };

export function devicePlugin(deps: AppDeps) {
  return oauthDeviceAuthorization({
    verificationUri: `${baseOf(deps.config.public_base_url)}/device`,
    expiresIn: "10m",
    interval: "5s",
  });
}

/**
 * The CLI's public client, as the api fixes it: no secret, the device and
 * refresh grants only, and /api/v1 as its one resource. Run whenever Better
 * Auth is built, after it has seeded the resources.
 */
export async function registerCliClient(db: Db, base: URL): Promise<void> {
  const now = new Date();
  const fixed = {
    name: "pbmb, the command line",
    tokenEndpointAuthMethod: "none",
    grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
    responseTypes: [],
    redirectUris: [],
    scopes: CLI_SCOPES,
    skipConsent: false,
    updatedAt: now,
  };
  await db
    .insert(oauthClient)
    .values({
      id: randomUUID(),
      clientId: CLI_CLIENT_ID,
      createdAt: now,
      ...fixed,
    })
    .onConflictDoUpdate({ target: oauthClient.clientId, set: fixed });
  await db
    .insert(oauthClientResource)
    .values({
      id: randomUUID(),
      clientId: CLI_CLIENT_ID,
      resourceId: resourceUri(base, "v1"),
      createdAt: now,
    })
    .onConflictDoNothing();
}

/** What /device/code takes that Better Auth would and this api does not, or null. */
async function refusal(request: Request): Promise<Response | null> {
  const form = await readForm(request);
  if (form === null || repeatsAField(form))
    return oauthError("invalid_request", NOT_A_FORM);
  // Binding a code to a person before they see it is how a phisher would start.
  if (form.has("user_id"))
    return oauthError("invalid_request", "A device code names no person.");
  if (form.get("client_id") !== CLI_CLIENT_ID)
    return oauthError(
      "invalid_client",
      "Only pbmb signs in with a device code.",
    );
  if (!form.get("resource"))
    return oauthError(
      "invalid_target",
      "Name the resource, as resource=<this site>/api/v1.",
    );
  const scopes = (form.get("scope") ?? "").split(" ");
  if (!CLI_SCOPES.every((scope) => scopes.includes(scope)))
    return oauthError(
      "invalid_scope",
      `Ask for scope=${CLI_SCOPES.join(" ")}.`,
    );
  return null;
}

/**
 * The device authorization endpoint for the CLI only. No
 * verification_uri_complete, so the person types the code; when and from
 * which address (`client`) it started is kept for the /device screen.
 */
export async function guardDevice(
  deps: AppDeps,
  request: Request,
  client: string | null,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/auth/device/code")
    return forward(request);
  const refused = await refusal(request);
  if (refused !== null) return refused;
  const response = await forward(request);
  if (!response.ok) return response;
  const body = (await response.json()) as Record<string, unknown> & {
    device_code: string;
  };
  const [code] = await deps.db
    .select({ id: deviceCode.id })
    .from(deviceCode)
    .where(eq(deviceCode.deviceCode, body.device_code));
  if (code === undefined)
    throw new Error("Better Auth answered a device code it did not store.");
  await deps.db.insert(deviceRequestTable).values({
    device_code_id: code.id,
    started_at: deps.clock(),
    started_from: client,
  });
  delete body.verification_uri_complete;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(body, { status: response.status, headers });
}

const NO_REQUEST =
  "No sign-in waits for this code. Check the code, or run pbmb login again.";

/** A pending, unexpired code for the CLI, unclaimed or claimed by this person, with where it came from. */
async function pendingCode(
  deps: AppDeps,
  user_code: string,
  person_id: string,
) {
  const typed = [
    user_code,
    user_code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
  ];
  const [code] = await deps.db
    .select({
      user_code: deviceCode.userCode,
      user_id: deviceCode.userId,
      status: deviceCode.status,
      expires_at: deviceCode.expiresAt,
      client_id: deviceCode.oauthClientId,
      started_at: deviceRequestTable.started_at,
      started_from: deviceRequestTable.started_from,
    })
    .from(deviceCode)
    .innerJoin(
      deviceRequestTable,
      eq(deviceRequestTable.device_code_id, deviceCode.id),
    )
    .where(inArray(deviceCode.userCode, typed));
  if (
    code === undefined ||
    code.status !== "pending" ||
    code.expires_at.getTime() <= Date.now() ||
    code.client_id !== CLI_CLIENT_ID ||
    (code.user_id !== null && code.user_id !== person_id)
  )
    throw new ServiceError("not_found", NO_REQUEST);
  return code;
}

/** The caller as nobody: Better Auth's lookup then claims nothing, and still counts against the caller's address. */
function anonymous(caller: Caller): Caller {
  const headers = new Headers(caller.headers);
  headers.delete("cookie");
  return { headers, peer: caller.peer };
}

/**
 * What the SPA's /device page shows for a code the person typed: who asks,
 * when and from which address the request started, and what allowing
 * gives. Looking does not claim the code; answering does.
 */
export async function deviceRequest(
  deps: AppDeps,
  auth: Auth,
  caller: Caller,
  principal: Principal,
  user_code: string,
) {
  const lookup = `/device?user_code=${encodeURIComponent(user_code)}`;
  if (!(await askAsPerson(deps, auth, anonymous(caller), lookup)).ok)
    throw new ServiceError("not_found", NO_REQUEST);
  const code = await pendingCode(deps, user_code, principal.id);
  return {
    user_code: code.user_code,
    client_id: CLI_CLIENT_ID,
    client_name: "pbmb, the command line",
    started_at: code.started_at.toISOString(),
    started_from: code.started_from,
    will: [
      "Do everything you can do on this site, as you, from the command line",
      "Run queries in Power BI as you, with your own access",
    ],
    will_not: ["Reach anything your own roles and Power BI access do not"],
  };
}

/**
 * Allow or Deny a code the person typed, claiming it for them first.
 * Allowing records their consent before approving, so the CLI's next poll
 * gets tokens of a standing grant. Every failure answers one sentence.
 */
export async function answerDevice(
  deps: AppDeps,
  auth: Auth,
  caller: Caller,
  principal: Principal,
  user_code: string,
  allow: boolean,
): Promise<void> {
  const lookup = `/device?user_code=${encodeURIComponent(user_code)}`;
  if (!(await askAsPerson(deps, auth, caller, lookup)).ok)
    throw new ServiceError("not_found", NO_REQUEST);
  const code = await pendingCode(deps, user_code, principal.id);
  if (code.user_id !== principal.id)
    throw new ServiceError("not_found", NO_REQUEST);
  const consented = allow ? await consentToCli(deps.db, principal.id) : null;
  const answer = await askAsPerson(
    deps,
    auth,
    caller,
    allow ? "/device/approve" : "/device/deny",
    { userCode: code.user_code },
  );
  if (answer.ok) return;
  if (consented !== null)
    await deps.db.delete(oauthConsent).where(eq(oauthConsent.id, consented));
  throw new ServiceError("not_found", NO_REQUEST);
}

/** The id of a consent this call made, or null when the person's consent to the CLI already stood. */
async function consentToCli(db: Db, user_id: string): Promise<string | null> {
  const [standing] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.clientId, CLI_CLIENT_ID),
        eq(oauthConsent.userId, user_id),
      ),
    );
  if (standing !== undefined) return null;
  // Whole seconds on the real clock, as Better Auth stamps a token's iat.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const id = randomUUID();
  await db.insert(oauthConsent).values({
    id,
    clientId: CLI_CLIENT_ID,
    userId: user_id,
    scopes: CLI_SCOPES,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
