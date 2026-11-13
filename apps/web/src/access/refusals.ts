import { ApiError } from "../api/client";

/**
 * What the sign-in page says for each `error` the api sends a refused
 * sign-in back with (apps/api/src/services/auth/sign-in.ts). The words are
 * the page's own: `error_description` is never shown, because anyone can put
 * a link to /sign-in with their own text in it.
 */
const REFUSALS = new Map([
  [
    "email_not_found",
    "Microsoft sent no email address for this account. An admin can add the email optional claim in the app registration's Token configuration.",
  ],
  [
    "deactivated",
    "An admin has deactivated your account. Ask an admin to reactivate it.",
  ],
  [
    "not_in_tenant",
    "This Microsoft account is not in the company's Power BI tenant.",
  ],
  ["unknown_sign_in", "This way of signing in is not turned on."],
]);

const WRONG_PASSWORD =
  "The email or password is wrong; try again or reset your password.";

const UNKNOWN =
  "Sign-in did not finish. Try again, or ask one of this site's admins.";

export function refusalSentence(
  error: string,
  brand = "Power BI Metrics Book",
): string {
  if (error.toLowerCase() === "not_assigned")
    return `You do not have access yet. Ask an admin of ${brand} to invite you.`;
  return REFUSALS.get(error.toLowerCase()) ?? UNKNOWN;
}

export function authRefusal(error: unknown, credentials = false): string {
  if (error instanceof ApiError)
    return credentials && error.status === 401 ? WRONG_PASSWORD : error.message;
  return "Sign-in stopped because of a fault in this page. Reload it and try again.";
}
