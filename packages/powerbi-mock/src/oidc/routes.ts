import { Hono, type Context } from "hono";
import { findPerson, originOf, type MockState } from "../entra/context.js";
import {
  clientCredentials,
  newSecret,
  redeemCode,
  redirectWith,
} from "../entra/grants.js";
import {
  signToken,
  requestsScope,
  TOKEN_LIFETIME_SECONDS,
  verifyBearer,
} from "../entra/tokens.js";
import type { Person } from "../tenant.js";

/** RFC 6749 section 5.2's error body, the shape every generic provider answers. */
function oauthError(
  c: Context,
  status: 400 | 401,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, status);
}

/**
 * A generic OpenID Connect provider, the stand-in for Okta or Keycloak when a
 * test adds a second sign-in provider. It signs in the acting person for any
 * client the tenant lists in apps_registrations, and puts the person's group
 * ids in a `groups` claim. Mount it at /oidc.
 * https://openid.net/specs/openid-connect-core-1_0.html
 */
export function oidcRoutes(state: MockState): Hono {
  const app = new Hono();
  const issuer = (c: Context) => `${originOf(state, c)}/oidc`;
  const claimsOf = (person: Person) => ({
    sub: person.object_id,
    name: person.name,
    email: person.email,
    email_verified: true,
    preferred_username: person.user_principal_name,
    groups: person.group_ids,
  });

  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: issuer(c),
      authorization_endpoint: `${issuer(c)}/authorize`,
      token_endpoint: `${issuer(c)}/token`,
      jwks_uri: `${issuer(c)}/jwks`,
      userinfo_endpoint: `${issuer(c)}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      code_challenge_methods_supported: ["S256"],
      claims_supported: [
        "sub",
        "name",
        "email",
        "email_verified",
        "preferred_username",
        "groups",
      ],
    }),
  );

  app.get("/jwks", (c) => c.json({ keys: [state.keys.jwk] }));

  app.get("/authorize", (c) => {
    const query = c.req.query();
    const registration = state.tenant.apps_registrations.find(
      (r) => r.client_id === query.client_id,
    );
    const redirect_uri = query.redirect_uri;
    if (
      !registration ||
      !redirect_uri ||
      !registration.redirect_uris.includes(redirect_uri)
    ) {
      return c.text(
        "Unknown client or a redirect_uri the client has not registered.",
        400,
      );
    }
    const refuse = (error: string, description: string) =>
      redirectWith(c, redirect_uri, {
        error,
        error_description: description,
        state: query.state,
      });

    if (query.response_type !== "code")
      return refuse(
        "unsupported_response_type",
        "The response_type must be 'code'.",
      );
    if (!query.scope?.split(" ").includes("openid"))
      return refuse("invalid_scope", "The scope must include openid.");
    // RFC 7636 leaves PKCE optional for a confidential client. The mock does
    // not: a product that dropped PKCE must fail against it.
    if (!query.code_challenge) {
      return refuse("invalid_request", "The code_challenge is required.");
    }
    if (query.code_challenge_method !== "S256") {
      return refuse(
        "invalid_request",
        "The code_challenge_method must be S256.",
      );
    }
    const person = findPerson(state, state.acting_user);
    if (!person) return refuse("login_required", "Nobody is signed in.");
    if (person.revoked)
      return refuse("access_denied", "The person's access was withdrawn.");

    const code = newSecret();
    state.codes.set(code, {
      provider: "oidc",
      client_id: registration.client_id,
      redirect_uri,
      scope: query.scope,
      person_oid: person.object_id,
      code_challenge: query.code_challenge,
      nonce: query.nonce ?? null,
      spent: false,
    });
    return redirectWith(c, redirect_uri, { code, state: query.state });
  });

  app.post("/token", async (c) => {
    const form: Record<string, string> = Object.fromEntries(
      new URLSearchParams(await c.req.text()),
    );
    if (form.grant_type !== "authorization_code") {
      return oauthError(
        c,
        400,
        "unsupported_grant_type",
        "Only authorization_code is answered.",
      );
    }
    const credentials = clientCredentials(c, form);
    const registration = state.tenant.apps_registrations.find(
      (r) => r.client_id === credentials.client_id,
    );
    if (!registration || registration.secret !== credentials.secret) {
      return oauthError(
        c,
        401,
        "invalid_client",
        "Client authentication failed.",
      );
    }
    const redeemed = redeemCode(state, "oidc", form.code, {
      client_id: registration.client_id,
      redirect_uri: form.redirect_uri,
      code_verifier: form.code_verifier,
    });
    if ("failure" in redeemed) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        `The authorization code was refused (${redeemed.failure}).`,
      );
    }
    const { grant } = redeemed;
    const person = findPerson(state, grant.person_oid);
    if (!person || person.revoked)
      return oauthError(
        c,
        400,
        "invalid_grant",
        "The person's access was withdrawn.",
      );

    return c.json({
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      scope: grant.scope,
      access_token: await signToken(state, issuer(c), issuer(c), {
        sub: person.object_id,
        scope: grant.scope,
      }),
      id_token: await signToken(state, issuer(c), grant.client_id, {
        sub: person.object_id,
        groups: person.group_ids,
        ...(requestsScope(grant.scope, "profile")
          ? {
              name: person.name,
              preferred_username: person.user_principal_name,
            }
          : {}),
        ...(requestsScope(grant.scope, "email")
          ? { email: person.email, email_verified: true }
          : {}),
        nonce: grant.nonce ?? undefined,
      }),
    });
  });

  app.get("/userinfo", async (c) => {
    const bearer = await verifyBearer(
      state,
      c.req.header("authorization"),
      issuer(c),
    );
    const person =
      "claims" in bearer ? findPerson(state, bearer.claims.sub) : undefined;
    if (!person) {
      const description =
        "error" in bearer
          ? bearer.error
          : "The token names nobody in the tenant.";
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return oauthError(c, 401, "invalid_token", description);
    }
    return c.json(claimsOf(person));
  });

  return app;
}
