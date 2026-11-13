import type { SignInProvider } from "../src/context.js";

/** A valid OpenID Connect sign-in provider, for the settings tests that need one. */
export const OKTA_PROVIDER: SignInProvider = {
  id: "okta",
  kind: "oidc",
  label: "Okta",
  client_id: "abc",
  issuer: "https://example.okta.com",
};
