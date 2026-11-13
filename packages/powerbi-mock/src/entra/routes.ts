import { randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { findPerson, originOf, type MockState } from "./context.js";
import {
  clientCredentials,
  newSecret,
  redeemCode,
  redirectWith,
  type CodeFailure,
} from "./grants.js";
import {
  normalizeScope,
  requestsScope,
  resourceOf,
  shortScopeName,
  signToken,
  TOKEN_LIFETIME_SECONDS,
} from "./tokens.js";

type FormBody = Record<string, string>;
type Client = { secret: string };

/**
 * Microsoft's error body: error, error_description with its AADSTS code and
 * trace lines, error_codes and the ids.
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-response-1
 */
function oauthError(
  c: Context,
  status: 400 | 401,
  error: string,
  code: number,
  description: string,
): Response {
  const trace_id = randomUUID();
  const correlation_id = randomUUID();
  const timestamp = `${new Date().toISOString().slice(0, 19).replace("T", " ")}Z`;
  return c.json(
    {
      error,
      error_description: `AADSTS${String(code)}: ${description}\r\nTrace ID: ${trace_id}\r\nCorrelation ID: ${correlation_id}\r\nTimestamp: ${timestamp}`,
      error_codes: [code],
      timestamp,
      trace_id,
      correlation_id,
    },
    status,
  );
}

function codeFailureResponse(c: Context, failure: CodeFailure): Response {
  switch (failure) {
    case "spent":
      return oauthError(
        c,
        400,
        "invalid_grant",
        54005,
        "OAuth2 Authorization code was already redeemed, please retry with a new valid code or use an existing refresh token.",
      );
    case "pkce":
      return oauthError(
        c,
        400,
        "invalid_grant",
        501481,
        "The Code_Verifier does not match the code_challenge supplied in the authorization request.",
      );
    case "mismatch":
      return oauthError(
        c,
        400,
        "invalid_grant",
        70000,
        "The authorization code was issued to another client or for another redirect_uri.",
      );
    case "unknown":
      return oauthError(
        c,
        400,
        "invalid_grant",
        70000,
        "The provided value for the input parameter 'code' is not valid. The authorization code is invalid or has expired.",
      );
  }
}

/** Microsoft identity for one tenant: authorize, token and the signing keys. */
export function entraRoutes(state: MockState): Hono {
  const app = new Hono();
  const issuer = (c: Context) =>
    `${originOf(state, c)}/${state.tenant.tenant_id}/v2.0`;

  // https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
  app.get("/:tenant/v2.0/.well-known/openid-configuration", (c) => {
    const tenant = c.req.param("tenant");
    if (
      tenant !== state.tenant.tenant_id &&
      !state.tenant.people.some(
        (person) =>
          person.email
            .slice(person.email.lastIndexOf("@") + 1)
            .toLowerCase() === tenant.toLowerCase(),
      )
    )
      return oauthError(
        c,
        400,
        "invalid_tenant",
        90002,
        `Tenant '${tenant}' not found.`,
      );
    const base = `${originOf(state, c)}/${state.tenant.tenant_id}`;
    return c.json({
      issuer: issuer(c),
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      token_endpoint: `${base}/oauth2/v2.0/token`,
      jwks_uri: `${base}/discovery/v2.0/keys`,
    });
  });

  const inTenant: MiddlewareHandler = async (c, next) => {
    const tenant = c.req.param("tenant");
    if (tenant !== state.tenant.tenant_id) {
      return oauthError(
        c,
        400,
        "invalid_request",
        90002,
        `Tenant '${String(tenant)}' not found.`,
      );
    }
    await next();
  };

  function authenticate<T extends Client>(
    c: Context,
    credentials: { client_id: string | undefined; secret: string | undefined },
    known: T | undefined,
  ): { client: T } | { response: Response } {
    if (!credentials.client_id) {
      return {
        response: oauthError(
          c,
          400,
          "invalid_request",
          900144,
          "The request body must contain the following parameter: 'client_id'.",
        ),
      };
    }
    if (!known) {
      return {
        response: oauthError(
          c,
          401,
          "invalid_client",
          700016,
          `Application with identifier '${credentials.client_id}' was not found in the directory '${state.tenant.tenant_id}'.`,
        ),
      };
    }
    if (known.secret !== credentials.secret) {
      return {
        response: oauthError(
          c,
          401,
          "invalid_client",
          7000215,
          `Invalid client secret provided. Ensure the secret being sent in the request is the client secret value for app '${credentials.client_id}'.`,
        ),
      };
    }
    return { client: known };
  }

  async function issueTokens(
    c: Context,
    grant: {
      client_id: string;
      scope: string;
      person_oid: string;
      nonce: string | null;
    },
    requested_scope: string,
    with_refresh_token: boolean,
  ): Promise<Response> {
    const person = findPerson(state, grant.person_oid);
    if (!person) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        50034,
        "The user account does not exist in the directory.",
      );
    }
    if (person.revoked) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        50173,
        "The provided grant has expired due to it being revoked, a fresh auth token is needed.",
      );
    }
    const { audience, scopes } = resourceOf(requested_scope);
    const identity = {
      oid: person.object_id,
      sub: person.object_id,
      name: person.name,
      preferred_username: person.guest
        ? person.home_address
        : person.user_principal_name,
    };
    const body: Record<string, unknown> = {
      token_type: "Bearer",
      scope: scopes.join(" "),
      expires_in: TOKEN_LIFETIME_SECONDS,
      ext_expires_in: TOKEN_LIFETIME_SECONDS,
      access_token: await signToken(state, issuer(c), audience, {
        ...identity,
        appid: grant.client_id,
        azp: grant.client_id,
        scp: scopes.map(shortScopeName).join(" "),
      }),
    };
    if (with_refresh_token) {
      const refresh_token = newSecret();
      state.refresh_tokens.set(refresh_token, {
        client_id: grant.client_id,
        scope: grant.scope,
        person_oid: person.object_id,
        spent: false,
      });
      body.refresh_token = refresh_token;
    }
    if (requestsScope(grant.scope, "openid")) {
      // groups: the claim Entra adds when an app registration asks for group membership claims.
      body.id_token = await signToken(state, issuer(c), grant.client_id, {
        sub: person.object_id,
        ...(requestsScope(grant.scope, "profile") ? identity : {}),
        // https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference#payload-claims
        ...(person.email &&
        (requestsScope(grant.scope, "email") ||
          person.guest ||
          state.tenant.apps_registrations.find(
            (app) => app.client_id === grant.client_id,
          )?.email_optional_claim)
          ? {
              email: person.email,
              // https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
              xms_edov:
                person.email.split("@")[1] ===
                person.user_principal_name.split("@")[1],
            }
          : {}),
        groups: person.group_ids,
        nonce: grant.nonce ?? undefined,
      });
    }
    return c.json(body);
  }

  async function clientCredentialsGrant(
    c: Context,
    form: FormBody,
  ): Promise<Response> {
    const credentials = clientCredentials(c, form);
    const principal = state.tenant.service_principals.find(
      (sp) => sp.app_id === credentials.client_id,
    );
    const auth = authenticate(c, credentials, principal);
    if ("response" in auth) return auth.response;
    const { client } = auth;
    const scope = form.scope ?? "";
    if (!scope.endsWith("/.default")) {
      return oauthError(
        c,
        400,
        "invalid_scope",
        70011,
        "The provided value for the input parameter 'scope' is not valid. A client credentials request must name its resource's /.default scope.",
      );
    }
    const access_token = await signToken(
      state,
      issuer(c),
      scope.slice(0, -"/.default".length),
      {
        oid: client.object_id,
        sub: client.object_id,
        appid: client.app_id,
        azp: client.app_id,
        idtyp: "app",
      },
    );
    return c.json({
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      ext_expires_in: TOKEN_LIFETIME_SECONDS,
      access_token,
    });
  }

  async function authorizationCodeGrant(
    c: Context,
    form: FormBody,
  ): Promise<Response> {
    const credentials = clientCredentials(c, form);
    const registration = state.tenant.apps_registrations.find(
      (r) => r.client_id === credentials.client_id,
    );
    const auth = authenticate(c, credentials, registration);
    if ("response" in auth) return auth.response;
    const redeemed = redeemCode(state, "microsoft", form.code, {
      client_id: auth.client.client_id,
      redirect_uri: form.redirect_uri,
      code_verifier: form.code_verifier,
    });
    if ("failure" in redeemed) return codeFailureResponse(c, redeemed.failure);
    const { grant } = redeemed;
    return issueTokens(
      c,
      grant,
      grant.scope,
      requestsScope(grant.scope, "offline_access"),
    );
  }

  /** Rotation: every use answers a new refresh token and spends the old one. */
  async function refreshTokenGrant(
    c: Context,
    form: FormBody,
  ): Promise<Response> {
    const credentials = clientCredentials(c, form);
    const registration = state.tenant.apps_registrations.find(
      (r) => r.client_id === credentials.client_id,
    );
    const auth = authenticate(c, credentials, registration);
    if ("response" in auth) return auth.response;
    const grant = state.refresh_tokens.get(form.refresh_token ?? "");
    if (!grant || grant.client_id !== auth.client.client_id) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        70000,
        "The refresh token is not valid.",
      );
    }
    if (grant.spent) {
      return oauthError(
        c,
        400,
        "invalid_grant",
        70000,
        "The refresh token was already redeemed and replaced by a newer one.",
      );
    }
    const scope = form.scope ?? grant.scope;
    const granted = new Set(grant.scope.split(" ").map(normalizeScope));
    const outside = scope
      .split(" ")
      .filter(Boolean)
      .map(normalizeScope)
      .filter((candidate) => !granted.has(candidate));
    if (outside.length > 0) {
      return oauthError(
        c,
        400,
        "invalid_scope",
        70011,
        `The provided value for the input parameter 'scope' is not valid. The scope ${outside.join(" ")} was not part of the original request.`,
      );
    }
    grant.spent = true;
    return issueTokens(c, { ...grant, nonce: null }, scope, true);
  }

  app.get("/:tenant/discovery/v2.0/keys", inTenant, (c) =>
    c.json({ keys: [state.keys.jwk] }),
  );

  app.get("/:tenant/oauth2/v2.0/authorize", inTenant, (c) => {
    const query = c.req.query();
    const registration = state.tenant.apps_registrations.find(
      (r) => r.client_id === query.client_id,
    );
    if (!registration) {
      return c.text(
        `AADSTS700016: Application with identifier '${String(query.client_id)}' was not found in the directory '${state.tenant.tenant_id}'.`,
        400,
      );
    }
    const redirect_uri = query.redirect_uri;
    if (!redirect_uri || !registration.redirect_uris.includes(redirect_uri)) {
      return c.text(
        `AADSTS50011: The redirect URI '${String(redirect_uri)}' specified in the request does not match the redirect URIs configured for the application '${registration.client_id}'.`,
        400,
      );
    }
    const refuse = (error: string, description: string) =>
      redirectWith(c, redirect_uri, {
        error,
        error_description: description,
        state: query.state,
      });

    if (query.response_type !== "code") {
      return refuse(
        "unsupported_response_type",
        "The response_type must be 'code'.",
      );
    }
    // Entra lets a confidential client skip PKCE. The mock does not: a product
    // that dropped PKCE must fail against it, not pass because Entra is lax.
    if (!query.code_challenge) {
      return refuse(
        "invalid_request",
        "AADSTS501491: Invalid size of Code_Challenge parameter. The mock requires code_challenge with code_challenge_method=S256.",
      );
    }
    if (query.code_challenge_method !== "S256") {
      return refuse(
        "invalid_request",
        "AADSTS50149: Invalid Code_Challenge_method parameter.",
      );
    }
    const person = findPerson(state, state.acting_user);
    if (!person) {
      return refuse(
        "login_required",
        "AADSTS50058: A silent sign-in request was sent but no user is signed in.",
      );
    }
    if (person.revoked) {
      return refuse(
        "consent_required",
        `AADSTS65001: The user or administrator has not consented to use the application with ID '${registration.client_id}'. Send an interactive authorization request for this user and resource.`,
      );
    }
    const code = newSecret();
    state.codes.set(code, {
      provider: "microsoft",
      client_id: registration.client_id,
      redirect_uri,
      scope: query.scope ?? "",
      person_oid: person.object_id,
      code_challenge: query.code_challenge,
      nonce: query.nonce ?? null,
      spent: false,
    });
    return redirectWith(c, redirect_uri, { code, state: query.state });
  });

  app.post("/:tenant/oauth2/v2.0/token", inTenant, async (c) => {
    const form: FormBody = Object.fromEntries(
      new URLSearchParams(await c.req.text()),
    );
    switch (form.grant_type) {
      case "client_credentials":
        return clientCredentialsGrant(c, form);
      case "authorization_code":
        return authorizationCodeGrant(c, form);
      case "refresh_token":
        return refreshTokenGrant(c, form);
      default:
        return oauthError(
          c,
          400,
          "unsupported_grant_type",
          70003,
          `The app returned an unsupported grant type '${String(form.grant_type)}'.`,
        );
    }
  });

  return app;
}
