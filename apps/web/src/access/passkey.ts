import { ApiError } from "../api/client";
import { authCall } from "./api";

/*
 * Passkeys through Better Auth's passkey routes and the browser's own WebAuthn
 * JSON helpers (parse...FromJSON, toJSON), so no encoding of ours sits between
 * the authenticator and the api.
 */

/** A passkey prompt the person closed, or none on this device: said in one sentence rather than as a fault. */
function unused(error: unknown): ApiError | null {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? new ApiError(
        0,
        "passkey_not_used",
        "No passkey was used. Try again, or sign in another way.",
        { cause: error },
      )
    : null;
}

/** Signs in with a passkey; the answer is Better Auth's, with a url when an OAuth request continues. */
export async function signInWithPasskey(
  oauthQuery: string | null,
): Promise<unknown> {
  const options = await authCall("/passkey/generate-authenticate-options", {
    method: "GET",
  });
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
        options as PublicKeyCredentialRequestOptionsJSON,
      ),
    });
  } catch (error) {
    throw unused(error) ?? error;
  }
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("The browser answered a passkey request without one.");
  return authCall("/passkey/verify-authentication", {
    method: "POST",
    body: {
      response: credential.toJSON(),
      ...(oauthQuery === null ? {} : { oauth_query: oauthQuery }),
    },
  });
}

/** Better Auth adds a passkey only in a session's first 24 hours (its freshAge). */
function notFresh(error: unknown): ApiError | null {
  return error instanceof ApiError && error.kind === "SESSION_NOT_FRESH"
    ? new ApiError(
        error.status,
        error.kind,
        "Sign in again to add a passkey.",
        {
          cause: error,
        },
      )
    : null;
}

/** Registers a passkey for the person signed in. */
export async function addPasskey(): Promise<void> {
  let options: unknown;
  try {
    options = await authCall("/passkey/generate-register-options", {
      method: "GET",
    });
  } catch (error) {
    throw notFresh(error) ?? error;
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
        options as PublicKeyCredentialCreationOptionsJSON,
      ),
    });
  } catch (error) {
    throw unused(error) ?? error;
  }
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("The browser answered a passkey request without one.");
  try {
    await authCall("/passkey/verify-registration", {
      method: "POST",
      body: { response: credential.toJSON() },
    });
  } catch (error) {
    throw notFresh(error) ?? error;
  }
}
