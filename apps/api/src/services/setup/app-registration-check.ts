/*
 * The setup checks the minimum at Microsoft. The app registration must give a
 * person's token Power BI's Dataset.Read.All, and that alone fails it. A
 * permission too many passes with a note naming it: the app may serve another
 * product, and this one never uses it. The scanner registration holds no
 * permission at all, because Power BI's admin APIs refuse it otherwise. A
 * delegated token's scopes show what the app registration holds, and a
 * client-credentials token's `roles` claim the application permissions.
 *
 * Only Dataset.Read.All is required because only it can be read: the redeem
 * names the Power BI resource alone, so the answer need not list the sign-in
 * scopes or Graph's User.Read, and a connection that exists proves sign-in
 * and the refresh token worked.
 */

const POWER_BI = "https://analysis.windows.net/powerbi/api/";
const GRAPH = "https://graph.microsoft.com/";
const SIGN_IN = ["openid", "profile", "email", "offline_access"];
const DATASET_READ = `${POWER_BI}Dataset.Read.All`;
const MINIMUM = new Set([...SIGN_IN, DATASET_READ, `${GRAPH}User.Read`]);
/** A permission's own form; anything else in a token is not repeated. */
const PERMISSION = /^[A-Za-z]+(?:\.[A-Za-z]+){1,2}$/;
/** Longer than any Microsoft names: not repeated either, so it cannot crowd out the rest. */
const PERMISSION_MAX = 64;
/** What `setting_check.message` holds. */
const NOTE_MAX = 300;
/**
 * What a name alone shows an extra can do, in the order the note names them.
 * A write can go unseen: Mail.Send, Content.Create and Item.Execute.All match
 * nothing here, so they get no label and no place ahead of a read.
 */
const POWERS: readonly (readonly [RegExp, string])[] = [
  [/^tenant\..*readwrite/i, "can change every workspace"],
  [/^tenant\./i, "reads every workspace"],
  [/readwrite/i, "can write"],
];
/** The longest the application sentence may be beside the delegated one, which keeps room for at least its count. */
const APPLICATION_MAX = 195;

/** A scope with no resource is Microsoft Graph's, as Microsoft reads it. */
const withResource = (scope: string) =>
  SIGN_IN.includes(scope) || scope.includes("/") ? scope : `${GRAPH}${scope}`;
const shortName = (scope: string) => scope.slice(scope.lastIndexOf("/") + 1);

/** The sentence that fails the delegated scopes, or null when they hold what this app needs. */
export function permissionProblem(scopes: readonly string[]): string | null {
  return scopes.map(withResource).includes(DATASET_READ)
    ? null
    : "Your Power BI token lacks Dataset.Read.All. Add that delegated permission under API permissions, grant admin consent, then connect Power BI again.";
}

const powerOf = (name: string) => {
  const rank = POWERS.findIndex(([holds]) => holds.test(name));
  return rank === -1 ? POWERS.length : rank;
};
const withPower = (name: string) => {
  const power = POWERS[powerOf(name)]?.[1];
  return power === undefined ? name : `${name} (${power})`;
};

/** Names what fits in `room`, those whose names show what they can do first, and counts the rest. */
function listOf(extras: readonly string[], room: number): string {
  const repeatable = extras
    .filter((name) => name.length <= PERMISSION_MAX && PERMISSION.test(name))
    .toSorted((a, b) => powerOf(a) - powerOf(b))
    .map(withPower);
  const reserved = ` and ${String(extras.length)} more`.length;
  const named: string[] = [];
  for (const each of repeatable) {
    if ([...named, each].join(", ").length + reserved > room) break;
    named.push(each);
  }
  const more = extras.length - named.length;
  if (named.length === 0)
    return more === 1 ? "a permission" : `${String(more)} permissions`;
  if (more > 0) return `${named.join(", ")} and ${String(more)} more`;
  const head = named.slice(0, -1).join(", ");
  const last = named.slice(-1).join();
  return head === "" ? last : `${head} and ${last}`;
}

/** The application permissions in the token, which only the token for Power BI shows: what they are, and that no person stands behind them. */
function applicationSentence(
  roles: readonly string[],
  service_account_queries: boolean,
): string {
  const one = roles.length === 1;
  const acts = one
    ? "An application permission acts"
    : "Application permissions act";
  const sentence = (list: string) =>
    service_account_queries
      ? `${acts} without any person: ${list}. This app's service-account queries send the token holding ${one ? "it" : "them"}.`
      : `${acts} without any person: ${list}. This app does not use ${one ? "it" : "them"}, and ${one ? "it" : "they"} can be removed.`;
  return sentence(listOf(roles, APPLICATION_MAX - sentence("").length));
}

/** What a passing check says about what the app registration holds beyond the minimum; null when it holds nothing more. */
export function permissionNote(
  scopes: readonly string[],
  accessToken: string,
  {
    service_account_queries = false,
  }: { service_account_queries?: boolean } = {},
): string | null {
  const extras = [
    ...new Set(
      scopes
        .map(withResource)
        .filter((scope) => !MINIMUM.has(scope))
        .map(shortName),
    ),
  ];
  const roles = [...new Set(tokenRoles(accessToken))];
  const application =
    roles.length > 0
      ? applicationSentence(roles, service_account_queries)
      : null;
  if (extras.length === 0) return application;
  const after = application === null ? "" : ` ${application}`;
  const one = extras.length === 1;
  const note = (list: string) =>
    `Not needed by this app, which never uses ${one ? "it" : "them"}: ${list}. The app can still do what ${one ? "it allows" : "they allow"}.`;
  return (
    note(listOf(extras, NOTE_MAX - note("").length - after.length)) + after
  );
}

/** The application permissions a client-credentials token names; null when it cannot be read as a JWT. */
export function tokenRoles(accessToken: string): string[] | null {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const roles = "roles" in claims ? claims.roles : undefined;
  if (roles === undefined) return [];
  return Array.isArray(roles) ? roles.map(String) : null;
}

const UNREADABLE =
  "Microsoft answered a token this check cannot read, so its permissions are unknown. Run the check again; if it repeats, the authority setting may not be Microsoft's.";

/** The sentence that fails a client-credentials token: one that cannot be read, or a scanner's that holds a permission. The app registration's permissions are a note. */
export function rolesProblem(
  accessToken: string,
  registration: "app" | "scanner",
): string | null {
  const roles = tokenRoles(accessToken);
  if (roles === null) return UNREADABLE;
  return registration === "scanner" && roles.length > 0
    ? "The scanner registration holds an API permission. Remove it: Power BI refuses admin APIs to an app that holds one, and the tenant setting gives the scanner what it reads."
    : null;
}
