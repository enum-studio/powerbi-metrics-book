import { expect, it } from "vitest";
import { secretInWords } from "./secret-words.js";

it.each([
  ["powerbi_app_client_secret", "The app registration's client secret"],
  ["powerbi_scanner_client_secret", "The scanner registration's client secret"],
  ["sign_in_okta_client_secret", "The okta sign-in client secret"],
  ["result_link_key", "The result link key"],
  ["resend_api_key", "The Resend API key"],
  ["openai_api_key", "The OpenAI API key"],
  ["gemini_api_key", "The Gemini API key"],
] as const)("calls %s by words a person reads", (name, words) => {
  expect(secretInWords(name)).toBe(words);
});
