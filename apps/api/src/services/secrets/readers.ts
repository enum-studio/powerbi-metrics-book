import type { Container, SecretName } from "../../context.js";
import { ServiceError } from "../../errors.js";

type FixedSecretName = Exclude<SecretName, `sign_in_${string}_client_secret`>;

/** The spec's secrets table: who reads each secret. A container not listed never gets a ciphertext. */
const FIXED_READERS: Record<FixedSecretName, readonly Container[]> = {
  powerbi_app_client_secret: ["api"],
  powerbi_scanner_client_secret: ["worker"],
  result_link_key: ["api"],
  resend_api_key: ["api"],
  openai_api_key: ["api", "worker"],
  gemini_api_key: ["api", "worker"],
};

// The provider id becomes part of an environment variable's name, so it is
// limited to what a shell can export once upper-cased.
const SIGN_IN_SECRET = /^sign_in_[a-z0-9][a-z0-9_]*_client_secret$/;

function isFixedSecretName(name: string): name is FixedSecretName {
  return Object.hasOwn(FIXED_READERS, name);
}

export const FIXED_SECRET_NAMES: readonly SecretName[] =
  Object.keys(FIXED_READERS).filter(isFixedSecretName);

/** Refuses a name that is not a secret, so nothing is ever stored for a reader nobody declared. */
export function readersOf(name: string): readonly Container[] {
  if (isFixedSecretName(name)) return FIXED_READERS[name];
  if (SIGN_IN_SECRET.test(name)) return ["api"];
  throw new ServiceError("invalid", `There is no secret named ${name}.`);
}
