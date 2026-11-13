import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { AppDeps } from "../context.js";
import { signInConfigReader } from "../services/auth/sign-in-config.js";
import { documented } from "./v1/adapter.js";

const SignInConfig = z
  .object({
    providers: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["microsoft", "google", "oidc"]),
        name: z.string(),
      }),
    ),
    passkeys: z.boolean(),
    email_password: z.boolean(),
    dev_sign_in: z.boolean(),
    sample_data: z.boolean(),
    /** The public demo: one person, read-only, no sign-in. */
    demo: z.boolean(),
    setup_pending: z.boolean(),
    brand: z.object({
      name: z.string(),
      company: z.string().nullable(),
      logo_url: z.string().nullable(),
      /** Whether a company set its own name, so the page says it is powered by this product. */
      custom: z.boolean(),
    }),
    invite_only: z.boolean(),
  })
  .meta({ id: "SignInConfig" });

/**
 * GET /api/auth/config: what the sign-in page offers, for someone with no
 * session yet, so it is on the public list. Its schema declares no client id,
 * issuer, secret or redirect URI, and the answer is parsed by it, so none can
 * be added by accident.
 */
export function authConfigRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const config = documented(
    "How a person may sign in here: providers, passkeys and the dev sign-in, and whether this is the sample tenant",
    SignInConfig,
  );
  const read = signInConfigReader(deps);
  // The demo signs nobody in, so it offers no provider and no dev sign-in.
  routes.get("/api/auth/config", config.doc, async (c) => {
    const answer = await read();
    return config.answer(
      c,
      deps.config.demo_mode
        ? { ...answer, providers: [], dev_sign_in: false, demo: true }
        : { ...answer, demo: false },
    );
  });
  return routes;
}
