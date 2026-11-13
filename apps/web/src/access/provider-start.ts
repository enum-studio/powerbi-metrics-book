import { ApiError } from "../api/client";
import { answeredUrl, authCall } from "./api";
import { signInTarget } from "./links";
import type { Provider } from "./provider-marks";

export function providerStart(
  provider: Provider,
  next: string,
  oauthQuery: string | null,
) {
  // Microsoft chains into the Power BI connection before returning to next.
  const callbackURL =
    provider.kind === "microsoft"
      ? `/api/v1/powerbi/connect?next=${encodeURIComponent(next)}`
      : next;
  const oauth = oauthQuery === null ? {} : { oauth_query: oauthQuery };
  return authCall(
    provider.kind === "oidc" ? "/sign-in/sso" : "/sign-in/social",
    {
      method: "POST",
      body:
        provider.kind === "oidc"
          ? { providerId: provider.id, callbackURL, ...oauth }
          : { provider: provider.kind, callbackURL, ...oauth },
    },
  );
}

/** A provider redirect must pass the same address check on every auth page. */
export function signInAddress(answer: unknown): string | null {
  const url = answeredUrl(answer);
  if (url === null) return null;
  const target = signInTarget(url, window.location.origin);
  if (target === null)
    throw new ApiError(
      0,
      "unknown",
      "Sign-in answered with an address this page will not open. Tell your admin.",
    );
  return target;
}
