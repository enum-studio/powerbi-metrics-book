import { CronPattern } from "croner";
import { z } from "zod";
import type {
  SettingKey,
  SettingValue,
  SignInProvider,
} from "../../context.js";
import { SHIPPED_ROLES } from "../access/shipped-roles.js";

/*
 * Every setting: the schema its value must satisfy, the default it has until
 * someone sets it, and the sentence the admin section and `pbmb admin
 * settings` show beside it. The defaults are the spec's settings table.
 */

export type SettingEntry<K extends SettingKey> = {
  schema: z.ZodType<SettingValue<K>>;
  default: SettingValue<K>;
  description: string;
  /**
   * Where a secret is sent: the operator sets it in the environment, and no
   * admin can, so nobody who may only replace a secret can send it to a host
   * of their choosing.
   */
  environment_only?: true;
};

const guid = z.guid();
const url = z.url({ protocol: /^https?$/ });
const positiveInteger = z.number().int().positive();

/** croner reads the schedules, so croner decides what a valid one is. */
const cronLine = z.string().refine(
  (line) => {
    try {
      new CronPattern(line);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a cron line, such as 0 * * * *" },
);

const signInProvider: z.ZodType<SignInProvider> = z
  .object({
    // The id is part of the provider's secret name, sign_in_<id>_client_secret.
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, {
      message: "must be lower case letters, digits and underscores",
    }),
    kind: z.enum(["google", "oidc"]),
    label: z.string().min(1),
    client_id: z.string().min(1),
    issuer: url.nullable(),
  })
  .refine((provider) => provider.kind !== "oidc" || provider.issuer !== null, {
    message: "an OpenID Connect provider needs an issuer",
    path: ["issuer"],
  });

/**
 * A provider's id names its sign-ins and its groups, so it may not be a way
 * of signing in that has no provider (the dev sign-in, a passkey, Better
 * Auth's own credential), nor, for an OpenID Connect provider, Google's.
 */
const RESERVED_IDS = new Set(["dev", "passkey", "credential"]);

const signInProviders = z
  .array(signInProvider)
  .superRefine((providers, context) => {
    const seen = new Set<string>();
    for (const [index, { id, kind }] of providers.entries()) {
      // Microsoft is always on, with its own secret and callback.
      const message =
        id === "microsoft"
          ? "Microsoft sign-in is always on and is not listed"
          : RESERVED_IDS.has(id) || (kind === "oidc" && id === "google")
            ? `the id ${id} is reserved for another way of signing in`
            : seen.has(id)
              ? `the id ${id} is used twice`
              : null;
      if (message !== null)
        context.addIssue({ code: "custom", message, path: [index, "id"] });
      seen.add(id);
    }
  });

export const SETTINGS: { readonly [K in SettingKey]: SettingEntry<K> } = {
  "usage.capture": {
    schema: z.boolean(),
    default: true,
    description:
      "Record searches and requests made through the connector, the CLI and the API, so curators can see what the book is missing.",
  },
  "usage.retention_days": {
    schema: z.number().int().min(1).max(365),
    default: 180,
    description: "How many days searches and requests are kept.",
  },
  "powerbi.tenant_id": {
    schema: guid
      .refine(
        (tenant) =>
          tenant.toLowerCase() !== "9188040d-6c67-4c5b-b112-36a304b66dad",
        {
          message:
            "That is a personal Microsoft account. Use your work tenant ID.",
        },
      )
      .nullable(),
    default: null,
    description: "The Microsoft Entra tenant that owns the Power BI data.",
  },
  "powerbi.app_client_id": {
    schema: guid.nullable(),
    default: null,
    description:
      "The client id of the app registration that signs people in and holds their Power BI connections.",
  },
  "powerbi.scanner_client_id": {
    schema: guid.nullable(),
    default: null,
    description:
      "The client id of the scanner's app registration, which reads every workspace's metadata.",
  },
  "powerbi.authority": {
    schema: url,
    default: "https://login.microsoftonline.com",
    description:
      "Where Microsoft identity answers: the public cloud, another cloud, or the mock.",
    environment_only: true,
  },
  "powerbi.api_url": {
    schema: url,
    default: "https://api.powerbi.com",
    description: "The Power BI REST API's address.",
    environment_only: true,
  },
  "powerbi.graph_url": {
    schema: url,
    default: "https://graph.microsoft.com",
    description: "The Microsoft Graph API's address.",
    environment_only: true,
  },
  "powerbi.sync.schedule": {
    schema: cronLine,
    default: "0 * * * *",
    description: "When the incremental scan runs, as a cron line.",
  },
  "powerbi.sync.full_scan_schedule": {
    schema: cronLine,
    default: "30 2 * * *",
    description: "When the full scan runs, as a cron line.",
  },
  "powerbi.sync.workspaces.include": {
    schema: z.union([z.literal("all"), z.array(guid)]),
    default: "all",
    description:
      'The workspaces to sync: "all", or a list of workspace ids, where an empty list syncs none.',
  },
  "powerbi.sync.workspaces.exclude": {
    schema: z.array(guid),
    default: [],
    description: "Workspace ids the sync skips even when they are included.",
  },
  "powerbi.sync.workspaces.personal": {
    schema: z.boolean(),
    default: false,
    description: "Whether the sync reads people's personal workspaces.",
  },
  "powerbi.datasets.new": {
    schema: z.enum(["on", "off"]),
    default: "on",
    description:
      "Whether a dataset the sync finds for the first time starts on or off.",
  },
  "powerbi.service_account_queries": {
    schema: z.boolean(),
    default: false,
    description:
      "Whether service accounts may run queries, as the app's own service principal.",
  },
  "powerbi.connection_requires_matching_email": {
    schema: z.boolean(),
    default: false,
    description:
      "Require the person's recorded Microsoft account, or their verified email if none, and allow each account to connect to only one person.",
  },
  "powerbi.keep_connections_alive_days": {
    schema: positiveInteger.nullable(),
    default: null,
    description:
      "Refresh a Power BI connection idle this many days so it never expires; empty leaves them to expire.",
  },
  "access.metadata_visibility": {
    schema: z.enum(["powerbi", "everyone", "policy"]),
    default: "powerbi",
    description:
      "Who may see a dataset's description: those Power BI lets read it, everyone, or whoever the policy says.",
  },
  "access.default_role": {
    // Never admin, which would make everyone in the tenant an admin, nor
    // pii_reader, which would let everyone in the tenant read personal data.
    schema: z.enum(
      [
        "none",
        ...SHIPPED_ROLES.filter((r) => r !== "admin" && r !== "pii_reader"),
      ],
      { error: "must be none, viewer or curator, never admin or pii_reader" },
    ),
    // A new deployment stores none when setup binds its tenant
    // (services/setup/link.ts); one that never stored a choice keeps viewer.
    default: "viewer",
    description:
      "Who gets in with no assignment: none lets in only invited and assigned people; viewer or curator lets in everyone in the tenant with that role. Setup stores none on a new deployment.",
  },
  "sign_in.email_password": {
    schema: z.boolean(),
    default: false,
    description: "Allow invited people to sign in with a password.",
  },
  "email.from": {
    schema: z.email().nullable(),
    default: null,
    description: "The verified Resend sender address.",
  },
  "email.base_url": {
    schema: url,
    default: "https://api.resend.com",
    environment_only: true,
    description: "Where Resend receives email requests.",
  },
  "sign_in.providers": {
    schema: signInProviders,
    default: [],
    description:
      "The sign-in providers turned on besides Microsoft, each with its client id and issuer.",
  },
  "sign_in.passkeys": {
    schema: z.boolean(),
    default: false,
    description: "Whether people may sign in with a passkey.",
  },
  "branding.name": {
    schema: z.string().trim().min(1).max(60).nullable(),
    default: null,
    description:
      "The name shown on sign-in, invites and the app header instead of Power BI Metrics Book.",
  },
  "branding.company": {
    schema: z.string().trim().min(1).max(60).nullable(),
    default: null,
    description: "The company's name, shown on the sign-in page.",
  },
  "search.provider": {
    schema: z.enum(["openai", "gemini", "none"]),
    default: "none",
    description: "The embedding provider behind search by meaning, or none.",
  },
  "search.model": {
    schema: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/, {
        message:
          "must be a model's name: up to 100 letters, digits, dots, colons, hyphens and underscores",
      })
      .nullable(),
    default: null,
    description: "The embedding model the provider is asked for.",
  },
  "search.base_url": {
    schema: url.nullable(),
    default: null,
    description:
      "The embedding provider's address; empty uses the provider's own.",
    environment_only: true,
  },
  "results.ttl_hours": {
    schema: positiveInteger.max(72),
    default: 24,
    description:
      "How many hours a stored query result is kept. Results are kept at most 72 hours, because they hold company data.",
  },
  "results.preview_rows": {
    schema: positiveInteger,
    default: 20,
    description: "How many rows a query answers with before the full result.",
  },
  "results.page_rows_max": {
    // A stored page holds 500 rows; a read never spans more.
    schema: positiveInteger.max(500),
    default: 500,
    description:
      "The most rows one page of a stored result returns, at most 500.",
  },
  "results.daily_row_budget": {
    schema: positiveInteger,
    default: 1_000_000,
    description: "The most rows one person's queries may store in a day.",
  },
  "queries.rate_per_minute": {
    schema: positiveInteger,
    default: 60,
    description: "The most queries one principal may run in a minute.",
  },
  "service_accounts.rate_per_minute": {
    schema: positiveInteger,
    default: 60,
    description:
      "The most requests one service account may make to /api/v1 in a minute.",
  },
  "setup.completed_steps": {
    schema: z.array(z.string().min(1)),
    default: [],
    description: "The setup steps that have passed their check.",
  },
  "setup.completed_at": {
    schema: z.iso.datetime().nullable(),
    default: null,
    description: "When setup finished; empty while it has not.",
  },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** Object.keys loses the key type; the guard gets it back without a cast. */
export const SETTING_KEYS: readonly SettingKey[] =
  Object.keys(SETTINGS).filter(isSettingKey);

/** A zod failure as one sentence fragment: each problem with the path to it, joined by semicolons. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}
