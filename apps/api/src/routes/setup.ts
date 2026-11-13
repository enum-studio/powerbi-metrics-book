import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { AppDeps } from "../context.js";
import { SUBJECT_KINDS } from "../db/schema/roles.js";
import { ServiceError } from "../errors.js";
import { peerOf } from "../http/peer.js";
import type { Principal } from "../principal.js";
import { mayAdmin } from "../services/admin/guard.js";
import { apiConfig, type Auth } from "../services/auth/better-auth.js";
import { clientAddress } from "../services/auth/client-address.js";
import { countRequest } from "../services/rate-limit.js";
import {
  openSetupSession,
  SETUP_COOKIE,
  SETUP_PATH,
  SETUP_SIGN_IN_COOKIE,
  SETUP_SIGN_IN_COOKIE_PATH,
  type SetupSession,
  setupPrincipal,
  setupSession,
  startSetupSignIn,
} from "../services/setup/link.js";
import {
  runStep,
  SETUP_SESSION_STEPS,
  STEPS,
  setupState,
  stepInput,
} from "../services/setup/steps.js";
import { AddressDetails, WorkspaceDetails } from "../services/setup/checks.js";
import { lookupTenant } from "../services/setup/tenant-lookup.js";
import { ErrorBody, refuse, stamp } from "./v1/adapter.js";

/**
 * The setup API; its screen is the SPA's /setup. POST /api/setup/session
 * spends a setup link's token, GET /api/setup is the steps' state, and
 * POST /api/setup/steps/<step> runs one. They are public paths, so each
 * checks its own credential. The setup session, while no admin exists,
 * reads the state and runs the address, app registration and scanner steps;
 * every step needs an admin's browser session once there is an admin, and
 * every later step needs one at all times. To anyone else each answers 404.
 *
 * The credential and the rate limit run ahead of the validators, so a bad
 * request from a caller setup is not for answers exactly like a good one.
 */

const HIDDEN = () => new ServiceError("not_found", "There is no setup here.");
const RATE = { window_seconds: 60, max: 60 };
// Strict: no other site's page can send the session to the setup API.
const SESSION_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: SETUP_PATH,
} as const;
// Lax, as it must ride Microsoft's redirect back to the callback.
const SIGN_IN_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: SETUP_SIGN_IN_COOKIE_PATH,
  maxAge: 600,
} as const;

type Holder = { principal: Principal; session: SetupSession | null };
/** The credential middleware sets the holder for the handler behind it. */
type SetupEnv = AppEnv & { Variables: { holder: Holder } };

const Field = z.union([
  z.object({
    kind: z.literal("setting"),
    key: z.string(),
    value: z.unknown(),
  }),
  // A secret's field says whether it is set and its date, and has nowhere to hold its value.
  z.object({
    kind: z.literal("secret"),
    name: z.string(),
    set: z.boolean(),
    expires_at: z.string().nullable(),
  }),
]);
/** A page of the docs this stack serves, never an address elsewhere. */
const DocsPath = z.string().regex(/^\/docs\/[a-z0-9-]+(\/[a-z0-9-]+)*\/$/);
const TenantSettingsDetails = z.object({
  reason: z.literal("tenant_settings"),
});
const StepDetails = z.union([
  TenantSettingsDetails,
  WorkspaceDetails,
  AddressDetails,
  z.object({ providers: z.array(z.string()) }),
  z.object({
    default_role: z.string(),
    assignments: z
      .array(
        z.object({
          role: z.string(),
          subject_kind: z.enum(SUBJECT_KINDS),
          subject: z.string().nullable(),
          provider: z.string().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({ provider: z.literal("none") }),
  z.object({
    provider: z.enum(["openai", "gemini"]),
    model: z.string(),
    documents: z.number(),
    estimated_tokens: z.number(),
    cost_micro_usd: z.number().int(),
  }),
  z.object({
    mcp_url: z.string(),
    cli_install: z.string(),
    cli_login: z.string(),
  }),
  z.object({ measures: z.number(), datasets: z.number(), drafts: z.number() }),
  z.object({
    items: z.array(
      z.object({
        item: z.string(),
        status: z.enum(["passing", "failing", "explained"]),
        sentence: z.string(),
      }),
    ),
  }),
]);
const StoredCheck = z.object({
  status: z.enum(["passing", "failing"]),
  message: z.string().nullable(),
  checked_at: stamp,
  details: z
    .union([TenantSettingsDetails, WorkspaceDetails, AddressDetails])
    .optional(),
});
const State = z.object({
  holder: z.enum(["admin", "setup_link"]),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      docs_path: DocsPath,
      fields: z.array(Field),
      passed: z.boolean(),
      pending: z.boolean(),
      action: z.enum(["sign_in", "connect"]).nullable(),
      check: StoredCheck.nullable(),
      /** The scanner step only: the check of its credentials, apart from check, its full one. */
      credentials: z
        .object({ pending: z.boolean(), check: StoredCheck.nullable() })
        .optional(),
    }),
  ),
  completed_at: z.string().nullable(),
  /** The guide's page on what to do when a check fails. */
  failure_docs_path: DocsPath,
});
const StepAnswer = z.object({
  step: z.string(),
  status: z.enum(["passing", "failing"]),
  message: z.string().nullable(),
  confirm: z.object({ email: z.string(), name: z.string() }).optional(),
  action: z.enum(["sign_in", "connect"]).optional(),
  details: StepDetails.optional(),
  // The check waits on the worker: POST the step again with nothing in it, which starts nothing.
  pending: z.literal(true).optional(),
  next: z
    .object({
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      body: z.record(z.string(), z.string()).optional(),
    })
    .nullable(),
});

/*
 * A setup route's OpenAPI entry and its one way to answer, as documented() in
 * v1/adapter.ts gives the other routes. Setup answers 404 to anyone without a
 * setup session or an admin's browser session, and 429 past its rate limit,
 * so it documents those and not the 401 and 403 the others give. Without a
 * schema the route answers 204.
 */
function described<S extends z.ZodType>(
  summary: string,
  schema: S | null,
  {
    invalid = true,
    notFound = "There is no setup here for this caller.",
  }: { invalid?: boolean; notFound?: string } = {},
) {
  const error = (description: string) => ({
    description,
    content: { "application/json": { schema: resolver(ErrorBody) } },
  });
  return {
    doc: describeRoute({
      summary,
      responses: {
        ...(schema === null
          ? { 204: { description: summary } }
          : {
              200: {
                description: summary,
                content: { "application/json": { schema: resolver(schema) } },
              },
            }),
        ...(invalid ? { 400: error("The request is not valid.") } : {}),
        404: error(notFound),
        429: error("Too many setup requests."),
      },
    }),
    answer: (c: Context<SetupEnv>, value?: z.input<S>) =>
      schema === null
        ? c.body(null, 204)
        : c.body(JSON.stringify(schema.parse(value)), 200, {
            "Content-Type": "application/json",
          }),
  };
}

export function setupRoutes(deps: AppDeps, auth: Auth): Hono<SetupEnv> {
  const routes = new Hono<SetupEnv>();
  // A route that forgot its credential has no holder, and answers like any other stranger.
  const holderOf = (c: Context<SetupEnv>): Holder => {
    const found = c.get("holder") as Holder | undefined;
    if (found === undefined) throw HIDDEN();
    return found;
  };

  async function limit(c: Context<SetupEnv>): Promise<void> {
    const address = clientAddress(
      peerOf(c.env),
      c.req.raw.headers,
      apiConfig(deps.config),
    );
    const verdict = await countRequest(
      deps.db,
      `setup:${address ?? "unknown"}`,
      RATE,
      deps.clock(),
    );
    if (!verdict.allowed)
      throw new ServiceError(
        "rate_limited",
        `Too many setup requests. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
      );
  }

  /** The caller of the state (no step) or of one step: the setup session where it may, else an admin's browser session. */
  async function holder(
    c: Context<SetupEnv>,
    step: string | null,
  ): Promise<Holder> {
    await limit(c);
    const session = await setupSession(deps, getCookie(c, SETUP_COOKIE));
    if (session !== null) {
      if (step !== null && !SETUP_SESSION_STEPS.includes(step)) throw HIDDEN();
      return { principal: setupPrincipal(session), session };
    }
    const principal = c.get("principal");
    if (
      principal !== undefined &&
      c.get("person") !== undefined &&
      (await mayAdmin({ ...deps, principal }, "manage_settings"))
    )
      return { principal, session: null };
    throw HIDDEN();
  }

  const credential =
    (step: string | null): MiddlewareHandler<SetupEnv> =>
    async (c, next) => {
      c.set("holder", await holder(c, step));
      await next();
    };
  const limited: MiddlewareHandler<SetupEnv> = async (c, next) => {
    await limit(c);
    await next();
  };

  const opened = described(
    "Spend a setup link's token and open the setup session",
    null,
  );
  routes.post(
    `${SETUP_PATH}/session`,
    opened.doc,
    limited,
    validator(
      "json",
      z.strictObject({ token: z.string().min(1).max(500) }),
      refuse,
    ),
    async (c) => {
      const session = await openSetupSession(deps, c.req.valid("json").token);
      if (session === null) throw HIDDEN();
      setCookie(c, SETUP_COOKIE, session, SESSION_COOKIE);
      return opened.answer(c);
    },
  );

  const state = described("The setup steps and where each stands", State, {
    invalid: false,
  });
  routes.get(SETUP_PATH, state.doc, credential(null), async (c) =>
    state.answer(c, {
      holder: holderOf(c).session === null ? "admin" : "setup_link",
      ...(await setupState(deps)),
    }),
  );

  const tenant = described(
    "Find the tenant ID from a work email",
    z.object({ tenant_id: z.guid(), domain: z.string() }),
    {
      notFound:
        "There is no setup here for this caller, or Microsoft knows no tenant for the domain. The message distinguishes these cases.",
    },
  );
  routes.post(
    `${SETUP_PATH}/tenant`,
    tenant.doc,
    credential(null),
    validator(
      "json",
      z.strictObject({ email: z.string().min(1).max(320) }),
      refuse,
    ),
    async (c) =>
      tenant.answer(c, await lookupTenant(deps, c.req.valid("json").email)),
  );

  for (const step of STEPS) {
    const stepped = described(`Run the ${step.title} step`, StepAnswer);
    routes.post(
      `${SETUP_PATH}/steps/${step.id}`,
      stepped.doc,
      credential(step.id),
      validator("json", stepInput, refuse),
      async (c) => {
        const { principal, session } = holderOf(c);
        const input = c.req.valid("json");
        const signedIn =
          c.get("person") === undefined
            ? null
            : (c.get("principal")?.id ?? null);
        const { result, setup_ended } = await runStep(
          { ...deps, principal },
          step,
          input,
          {
            principal,
            person_id: signedIn,
            host: c.req.header("host") ?? null,
          },
          session,
        );
        if (setup_ended) deleteCookie(c, SETUP_COOKIE, SESSION_COOKIE);
        if (
          Object.keys(input.settings).length +
            Object.keys(input.secrets).length >
          0
        )
          auth.reread();
        if (result.action === "sign_in" && session !== null)
          setCookie(
            c,
            SETUP_SIGN_IN_COOKIE,
            await startSetupSignIn(deps, session),
            SIGN_IN_COOKIE,
          );
        const next =
          result.action === "sign_in"
            ? {
                method: "POST" as const,
                path: "/api/auth/sign-in/social",
                body: { provider: "microsoft", callbackURL: "/setup" },
              }
            : result.action === "connect"
              ? {
                  method: "GET" as const,
                  path: "/api/v1/powerbi/connect?next=/setup",
                }
              : null;
        return stepped.answer(c, { step: step.id, ...result, next });
      },
    );
  }

  return routes;
}
