import type { SecretName } from "../../context.js";

type SignInSecretName = Extract<SecretName, `sign_in_${string}_client_secret`>;

/** The words follow the secret's name, because the Secrets page lists it by that name. */
const FIXED_WORDS: Record<Exclude<SecretName, SignInSecretName>, string> = {
  powerbi_app_client_secret: "The app registration's client secret",
  powerbi_scanner_client_secret: "The scanner registration's client secret",
  result_link_key: "The result link key",
  resend_api_key: "The Resend API key",
  openai_api_key: "The OpenAI API key",
  gemini_api_key: "The Gemini API key",
};

const isSignInSecret = (name: SecretName): name is SignInSecretName =>
  name.startsWith("sign_in_");

/** What a sentence to a person calls a secret. */
export function secretInWords(name: SecretName): string {
  if (!isSignInSecret(name)) return FIXED_WORDS[name];
  const provider = name.slice("sign_in_".length, -"_client_secret".length);
  return `The ${provider} sign-in client secret`;
}
