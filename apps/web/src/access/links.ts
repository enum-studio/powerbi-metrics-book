/**
 * Where the access screens may send a browser. Each address comes from a
 * query string or an API answer, so each is checked before it is followed.
 */

/**
 * `?next=` as a path on this origin, or "/" for anything else: an absolute
 * or protocol-relative URL, a backslash or a control character. The same
 * rule as the api's returnPath (services/connection/connect.ts), so a next
 * this accepts is one the Power BI connection accepts too.
 */
export function safeNext(next: string | null, origin: string): string {
  if (
    next === null ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    /[\\\p{Cc}]/u.test(next)
  )
    return "/";
  const url = URL.parse(next, origin);
  if (url === null || url.origin !== origin) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A loopback host, where the dev stack's Microsoft mock answers; the api's own onTheMock rule. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * A sign-in provider's address from Better Auth, or a path of this origin:
 * https, or http on loopback for the dev stack's mock. Anything else, as a
 * javascript: URL, is null and never followed.
 */
export function signInTarget(url: string, origin: string): string | null {
  const parsed = URL.parse(url, origin);
  if (parsed === null) return null;
  if (parsed.origin === origin) return parsed.href;
  if (parsed.protocol === "https:") return parsed.href;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname))
    return parsed.href;
  return null;
}

/** Schemes a browser runs or reads locally rather than hands to an app. */
const NEVER_FOLLOWED = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
]);

/**
 * The consent's answer, followed only when it goes where the screen said it
 * would: the redirect's scheme and host as shown under the buttons.
 */
export function shownRedirect(
  url: string,
  shown: { scheme: string; host: string | null },
): string | null {
  const parsed = URL.parse(url);
  if (parsed === null || NEVER_FOLLOWED.has(parsed.protocol)) return null;
  if (parsed.protocol !== `${shown.scheme}:`) return null;
  if (parsed.host !== (shown.host ?? "")) return null;
  return parsed.href;
}
