import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import {
  invitePeople,
  listInvites,
  resendInvite,
  revokeInvite,
} from "../../services/auth/invites.js";
import { putLogo, deleteLogo } from "../../services/admin/branding.js";
import { requireAdmin } from "../../services/admin/guard.js";
import { emailReady } from "../../services/auth/email.js";
import { CONNECTION_STATUSES } from "../../db/schema/connection.js";
import { SYNC_KINDS, SYNC_STATUSES } from "../../db/schema/mirror.js";
import { SUBJECT_KINDS } from "../../db/schema/roles.js";
import { PII_RULE_KINDS } from "../../db/schema/pii.js";
import { listAudit } from "../../services/admin/audit.js";
import { listDatasets, setEnabled } from "../../services/admin/datasets.js";
import { checkState, runCheck } from "../../services/admin/checks.js";
import { revokeConnectionAs } from "../../services/admin/connections.js";
import { exportBook, importBook } from "../../services/admin/export.js";
import {
  assignRole,
  deactivatePerson,
  reactivatePerson,
  deletePerson,
  signOutPerson,
  setPersonRole,
  setPiiReader,
  listPeople,
  listRoleAssignments,
  revokeRole,
} from "../../services/admin/people.js";
import {
  listSecrets,
  SECRET_VALUE_MAX,
  setSecret,
  setSecretExpiry,
} from "../../services/admin/secrets.js";
import { getSetting, setSetting } from "../../services/admin/settings.js";
import { adminStatus } from "../../services/admin/status.js";
import {
  listRules,
  removeRule,
  setRule,
  suggest,
} from "../../services/pii/rules.js";
import { listSyncRuns, startSync } from "../../services/admin/sync.js";
import {
  createKey,
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  enableServiceAccount,
  getServiceAccount,
  listKeys,
  listServiceAccounts,
  revokeKey,
  updateServiceAccount,
} from "../../services/auth/service-accounts.js";
import {
  credential,
  documented,
  failures,
  guid,
  iso,
  refuse,
  removed,
  serviceContext,
  stamp,
  text,
} from "./adapter.js";
import { Grant } from "./grants.js";

/*
 * The admin section's routes, for the `admin` actions: each service asks
 * Cerbos for its own action, and a service account is refused every one but
 * read_status in code. No answer here has a field that could hold a secret's
 * value or a key, but the one that makes a key (AdminNewApiKey).
 */

const nullableStamp = stamp.nullable();
const Check = z
  .object({
    status: z.enum(["passing", "failing"]),
    message: z.string().max(300).nullable(),
    // A check the worker runs is still running: GET /admin/checks/{name} until it is not.
    pending: z.literal(true).optional(),
    /** What the check found, as the setup step's answer has it. */
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "AdminCheck" });
/** A check's result as both check routes answer it, with only the keys it holds. */
const checkAnswer = ({
  status,
  message,
  pending,
  details,
}: Awaited<ReturnType<typeof runCheck>>): z.infer<typeof Check> => ({
  status,
  message,
  ...(pending === undefined ? {} : { pending }),
  ...(details === undefined ? {} : { details }),
});
const Setting = z
  .object({
    key: z.string(),
    value: z.unknown(),
    source: z.enum(["environment", "database", "default"]),
    environment_variable: z.string(),
    description: z.string(),
    environment_only: z.boolean(),
    problem: z.string().nullable(),
    check: Check.extend({ checked_at: stamp }).nullable(),
    /** The redirect URIs of each way of signing in, for sign_in.providers; null for every other key. */
    redirect_uris: z
      .object({
        microsoft: z.array(z.string()),
        google: z.array(z.string()),
        oidc: z.array(z.string()),
      })
      .nullable(),
  })
  .meta({ id: "AdminSetting" });
/** The hint is the last four characters of a long secret; a field of four characters cannot hold a value. */
const Secret = z
  .object({
    name: z.string(),
    readers: z.array(z.enum(["api", "worker"])).readonly(),
    set: z.boolean(),
    needs_reentry_for: z.array(z.enum(["api", "worker"])),
    hint: z.string().max(4).nullable(),
    set_by: z.string().nullable(),
    set_at: nullableStamp,
    expires_at: nullableStamp,
    checked_at: nullableStamp,
    check_status: z.enum(["passing", "failing", "unchecked"]).nullable(),
    check_message: z.string().max(300).nullable(),
  })
  .meta({ id: "AdminSecret" });
const Named = z.object({ name: z.string() });
const Status = z.object({
  connections_needing_reconnect: z.number(),
  version: z.string(),
  git_sha: z.string(),
  // A read-only caller sees the first fields of each; the rest are for manage_settings.
  last_sync: z
    .object({
      status: z.enum(SYNC_STATUSES),
      started_at: stamp,
      finished_at: nullableStamp,
      kind: z.enum(SYNC_KINDS).optional(),
      error: z.string().nullable().optional(),
    })
    .nullable(),
  failing_checks: z.array(
    Named.extend({
      message: z.string().nullable().optional(),
      checked_at: nullableStamp.optional(),
    }),
  ),
  secrets_expiring: z.array(
    Named.extend({
      expires_at: stamp,
      days_left: z.number().optional(),
      urgent: z.boolean().optional(),
      warning: z.string().optional(),
    }),
  ),
  people_to_reconnect: z
    .array(z.object({ user_id: z.string(), email: z.string() }))
    .optional(),
});
const RoleAssignment = z
  .object({
    id: z.string(),
    role: z.string(),
    subject_kind: z.enum(SUBJECT_KINDS),
    subject: z.string().nullable(),
    provider: z.string().nullable(),
    granted_by: z.string(),
    granted_at: stamp,
  })
  .meta({ id: "AdminRoleAssignment" });
const Person = z.object({
  status: z.enum(["active", "deactivated"]),
  deactivated_at: nullableStamp,
  direct_role: z.string().nullable(),
  /** Where pii_reader comes from: direct when an assignment to the person gives it, inherited when only a group's, a domain's or the tenant's does; the assignments that give it. */
  pii_reader: z.object({
    source: z.enum(["none", "direct", "inherited"]),
    assignments: z.array(RoleAssignment),
  }),
  id: z.string(),
  /** The display name the sign-in provider gave; the email for someone who set a password. */
  name: z.string(),
  title: z.string(),
  email: z.string(),
  sign_in_method: z.string().nullable(),
  last_seen_at: nullableStamp,
  powerbi_connection: z.enum([...CONNECTION_STATUSES, "not_connected"]),
  grants: z.array(Grant),
  roles: z.array(
    z.object({
      role: z.string(),
      assignments: z.array(RoleAssignment),
      by_default: z.boolean(),
    }),
  ),
});
const SyncRun = z
  .object({
    id: z.string(),
    kind: z.enum(SYNC_KINDS),
    trigger: z.enum(["schedule", "manual", "deploy"]),
    started_at: stamp,
    finished_at: nullableStamp,
    status: z.enum(SYNC_STATUSES),
    workspaces_scanned: z.number(),
    counts: z.record(z.string(), z.number()),
    error: z.string().nullable(),
  })
  .meta({ id: "AdminSyncRun" });
const ServiceAccount = z
  .object({
    name: z.string(),
    owner_email: z.string(),
    roles: z.array(z.string()),
    workspace_ids: z.array(z.string()),
    app_ids: z.array(z.string()),
    source_cidrs: z.array(z.string()),
    max_key_age_days: z.number(),
    disabled_at: nullableStamp,
    created_by: z.string(),
    created_at: stamp,
  })
  .meta({ id: "AdminServiceAccount" });
/** A key as the list shows it: its prefix tells keys apart, and nothing in it opens an account. */
const ApiKey = z
  .object({
    id: z.string(),
    service_account: z.string(),
    prefix: z.string(),
    created_by: z.string(),
    created_at: stamp,
    expires_at: stamp,
    last_used_at: nullableStamp,
    revoked_at: nullableStamp,
  })
  .meta({ id: "AdminApiKey" });
/** The one answer that holds a key: the create. */
const NewApiKey = ApiKey.extend({ key: z.string() }).meta({
  id: "AdminNewApiKey",
});
const AuditEvent = z
  .object({
    id: z.number(),
    at: stamp,
    principal_kind: z.string(),
    principal_id: z.string(),
    via: z.string(),
    client_id: z.string().nullable(),
    action: z.string(),
    resource_kind: z.string().nullable(),
    resource_id: z.string().nullable(),
    decision: z.enum(["allow", "deny"]),
    reason: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "AdminAuditEvent" });
const Import = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      before: z.unknown(),
      after: z.unknown(),
      check: Check.nullable().optional(),
    }),
  ),
  kept: z.object({
    settings: z.array(z.string()),
    role_assignments: z.array(z.record(z.string(), z.unknown())),
    service_accounts: z.array(z.string()),
  }),
  applied: z.boolean(),
});

const ByName = z.object({ name: text });
const roleFields = { role: text, custom: z.literal(true).optional() };
const NewAssignment = z.discriminatedUnion("subject_kind", [
  z.strictObject({
    ...roleFields,
    subject_kind: z.enum(["person", "email_domain"]),
    subject: text,
  }),
  z.strictObject({
    ...roleFields,
    subject_kind: z.literal("group"),
    provider: text,
    subject: text,
  }),
  z.strictObject({
    ...roleFields,
    subject_kind: z.literal("everyone_in_tenant"),
  }),
]);
const accountFields = {
  owner_email: text,
  roles: z.array(text).max(20),
  workspace_ids: z.array(guid).max(1000),
  app_ids: z.array(guid).max(1000),
  source_cidrs: z.array(text).max(100),
  max_key_age_days: z.number().int().min(1).max(90),
};
const NewAccount = z.strictObject({
  ...accountFields,
  name: text,
  workspace_ids: accountFields.workspace_ids.optional(),
  app_ids: accountFields.app_ids.optional(),
  source_cidrs: accountFields.source_cidrs.optional(),
  max_key_age_days: accountFields.max_key_age_days.optional(),
});
// Disabling and a change of fields are two changes, so one request makes one of them.
const AccountChange = z.union([
  z.strictObject({ disabled: z.boolean() }),
  z.strictObject(accountFields).partial(),
]);

/** GET, PUT and POST under /api/v1/admin: settings, secrets, checks, status, people, sync, service accounts, grants, audit and book.yml. */
export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const PiiRule = z.object({
    id: z.string(),
    kind: z.enum(PII_RULE_KINDS),
    table_name: z.string(),
    name: z.string().nullable(),
    pii: z.boolean(),
    note: z.string().nullable(),
    set_by_kind: z.string(),
    set_by_id: z.string(),
    set_via: z.string(),
    set_at: z.iso.datetime(),
    version: z.string(),
  });
  const listedRules = documented(
    "List PII rules with their current live coverage",
    z.object({
      rules: z.array(
        PiiRule.extend({ columns: z.number(), datasets: z.number() }),
      ),
    }),
  );
  routes.get(
    "/admin/pii/rules",
    listedRules.doc,
    credential,
    validator(
      "query",
      z.strictObject({ pii: z.enum(["true", "false"]).optional() }),
      refuse,
    ),
    async (c) =>
      listedRules.answer(c, {
        rules: await listRules(as(c), {
          pii:
            c.req.valid("query").pii === undefined
              ? undefined
              : c.req.valid("query").pii === "true",
        }),
      }),
  );
  const savedRule = documented(
    "Set a PII rule",
    z.object({
      rule: PiiRule,
      before: PiiRule.nullable(),
      columns: z.number(),
      measures: z.number(),
      datasets: z.number(),
    }),
    { errors: [400, 409] },
  );
  routes.put(
    "/admin/pii/rules",
    savedRule.doc,
    credential,
    validator(
      "json",
      z.strictObject({
        expected_version: z.string().min(1).max(100).nullable().optional(),
        kind: z.enum(PII_RULE_KINDS),
        table: z.string().min(1).max(200),
        name: z.string().max(200).optional(),
        pii: z.boolean(),
        note: z.string().max(500).nullable().optional(),
      }),
      refuse,
    ),
    async (c) => {
      const { table, ...input } = c.req.valid("json");
      return savedRule.answer(
        c,
        await setRule(as(c), { ...input, table_name: table }),
      );
    },
  );
  const deleteRule = removed("Remove a PII rule", [400, 404, 409]);
  routes.delete(
    "/admin/pii/rules/:id",
    deleteRule.doc,
    credential,
    validator("param", z.object({ id: guid }), refuse),
    validator(
      "query",
      z.strictObject({
        expected_version: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("The expected rule version."),
      }),
      refuse,
    ),
    async (c) => {
      const expected = c.req.valid("query").expected_version;
      await removeRule(as(c), c.req.valid("param").id, expected);
      return deleteRule.answer(c);
    },
  );
  const suggestions = documented(
    "Suggest columns that may contain PII",
    z.object({
      suggestions: z.array(
        z.object({
          dataset_id: z.string(),
          dataset_name: z.string(),
          table_name: z.string(),
          column_name: z.string(),
          matched: z.string(),
        }),
      ),
    }),
    { errors: [404] },
  );
  routes.get(
    "/admin/pii/suggestions",
    suggestions.doc,
    credential,
    validator("query", z.strictObject({ dataset: text.optional() }), refuse),
    async (c) =>
      suggestions.answer(c, {
        suggestions: await suggest(as(c), c.req.valid("query")),
      }),
  );
  const datasets = documented(
    "List datasets and their live contents",
    z.object({
      datasets: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          workspace_id: z.string(),
          workspace_name: z.string(),
          enabled: z.boolean(),
          tables: z.number(),
          columns: z.number(),
          measures: z.number(),
          synced_at: z.iso.datetime().nullable(),
        }),
      ),
    }),
  );
  routes.get("/admin/datasets", datasets.doc, credential, async (c) =>
    datasets.answer(c, { datasets: await listDatasets(as(c)) }),
  );
  const datasetState = documented(
    "Enable or disable a dataset",
    z.object({ id: z.string(), name: z.string(), enabled: z.boolean() }),
    { errors: [400, 404] },
  );
  routes.put(
    "/admin/datasets/:dataset",
    datasetState.doc,
    credential,
    validator(
      "param",
      z.object({ dataset: z.string().min(1).max(500) }),
      refuse,
    ),
    validator("json", z.strictObject({ enabled: z.boolean() }), refuse),
    async (c) =>
      datasetState.answer(
        c,
        await setEnabled(
          as(c),
          c.req.valid("param").dataset,
          c.req.valid("json").enabled,
        ),
      ),
  );

  const getOne = documented("A setting with its last check", Setting, {
    errors: [404],
  });
  routes.get(
    "/admin/settings/:key",
    getOne.doc,
    credential,
    validator("param", z.object({ key: text }), refuse),
    async (c) =>
      getOne.answer(c, await getSetting(as(c), c.req.valid("param").key)),
  );
  const putOne = documented(
    "Save a setting after its check; save_failing keeps a failing value",
    Setting,
    { errors: [400] },
  );
  routes.put(
    "/admin/settings/:key",
    putOne.doc,
    credential,
    validator("param", z.object({ key: text }), refuse),
    validator(
      "json",
      z.strictObject({
        value: z.unknown(),
        save_failing: z.boolean().default(false),
      }),
      refuse,
    ),
    async (c) => {
      const { value, save_failing } = c.req.valid("json");
      return putOne.answer(
        c,
        await setSetting(as(c), c.req.valid("param").key, value, {
          save_failing,
        }),
      );
    },
  );

  const secrets = documented(
    "Every secret: whether it is set, its last four characters, who set it, its expiry and last check",
    z.object({ secrets: z.array(Secret) }),
  );
  routes.get("/admin/secrets", secrets.doc, credential, async (c) =>
    secrets.answer(c, { secrets: await listSecrets(as(c)) }),
  );
  const putSecret = documented(
    "Set a secret. Write-only: the answer never holds the value",
    Secret,
    { errors: [400] },
  );
  routes.put(
    "/admin/secrets/:name",
    putSecret.doc,
    credential,
    validator("param", ByName, refuse),
    validator(
      "json",
      z.strictObject({
        value: z.string().min(1).max(SECRET_VALUE_MAX),
        expires_at: iso.nullable().default(null),
      }),
      refuse,
    ),
    async (c) => {
      const { value, expires_at } = c.req.valid("json");
      return putSecret.answer(
        c,
        await setSecret(as(c), c.req.valid("param").name, value, {
          expires_at: expires_at === null ? null : new Date(expires_at),
        }),
      );
    },
  );

  const putSecretExpiry = documented(
    "Set a saved secret's expiry date, leaving its value as it is",
    Secret,
    { errors: [400] },
  );
  routes.put(
    "/admin/secrets/:name/expiry",
    putSecretExpiry.doc,
    credential,
    validator("param", ByName, refuse),
    validator("json", z.strictObject({ expires_at: iso.nullable() }), refuse),
    async (c) => {
      const { expires_at } = c.req.valid("json");
      return putSecretExpiry.answer(
        c,
        await setSecretExpiry(
          as(c),
          c.req.valid("param").name,
          expires_at === null ? null : new Date(expires_at),
        ),
      );
    },
  );

  const check = documented("Run a check by name and keep its result", Check, {
    errors: [404],
  });
  routes.post(
    "/admin/checks/:name",
    check.doc,
    credential,
    validator("param", ByName, refuse),
    async (c) => {
      // Not the step's confirm and action, which are for the setup's browser.
      return check.answer(
        c,
        checkAnswer(await runCheck(as(c), c.req.valid("param").name)),
      );
    },
  );
  const checking = documented(
    "Where a check the worker runs stands; it starts nothing",
    Check,
    { errors: [404] },
  );
  routes.get(
    "/admin/checks/:name",
    checking.doc,
    credential,
    validator("param", ByName, refuse),
    async (c) =>
      checking.answer(
        c,
        checkAnswer(await checkState(as(c), c.req.valid("param").name)),
      ),
  );

  const status = documented(
    "The last sync, failing checks and secrets near expiry (admin:read_status)",
    Status,
  );
  routes.get("/admin/status", status.doc, credential, async (c) =>
    status.answer(c, await adminStatus(as(c))),
  );

  const roles = documented(
    "Every role assignment",
    z.object({ roles: z.array(RoleAssignment) }),
  );
  routes.get("/admin/roles", roles.doc, credential, async (c) =>
    roles.answer(c, { roles: await listRoleAssignments(as(c)) }),
  );
  const assign = documented("Assign a role", RoleAssignment, {
    status: 201,
    errors: [400, 409],
  });
  routes.post(
    "/admin/roles",
    assign.doc,
    credential,
    validator("json", NewAssignment, refuse),
    async (c) => {
      const { custom, ...assignment } = c.req.valid("json");
      return assign.answer(
        c,
        await assignRole(as(c), assignment, { custom: custom === true }),
      );
    },
  );
  const revoke = removed(
    "Revoke a role assignment, never the last admin's",
    [404, 409],
  );
  routes.delete(
    "/admin/roles/:id",
    revoke.doc,
    credential,
    validator("param", z.object({ id: guid }), refuse),
    async (c) => {
      await revokeRole(as(c), c.req.valid("param").id);
      return revoke.answer(c);
    },
  );

  // Ahead of a route's body: a caller who is not an admin is refused before
  // the body is read or described. The service checks again.
  const admitted =
    (action: "manage_people" | "manage_settings"): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      await requireAdmin(as(c), action);
      await next();
    };
  const InviteLink = z.object({
    expires_at: stamp,
    link: z.string().nullable(),
  });
  const invitation = documented(
    "Invite people by email or link",
    z.object({
      invites: z.array(
        InviteLink.extend({ id: z.string(), email: z.string() }),
      ),
    }),
    { errors: [400, 409, 429] },
  );
  routes.post(
    "/admin/people/invites",
    invitation.doc,
    credential,
    admitted("manage_people"),
    validator(
      "json",
      z.object({
        emails: z.array(z.email()).min(1).max(50),
        role: z.string(),
        delivery: z.enum(["email", "link"]),
        custom: z.boolean().optional(),
      }),
      refuse,
    ),
    async (c) =>
      invitation.answer(c, await invitePeople(as(c), c.req.valid("json"))),
  );
  const invitations = documented(
    "List open invites",
    z.object({
      invites: z.array(
        z.object({
          id: z.string(),
          email: z.string(),
          role: z.string(),
          delivery: z.enum(["email", "link"]),
          inviter_name: z.string(),
          last_sent_at: stamp,
          expires_at: stamp,
          expired: z.boolean(),
        }),
      ),
      email_ready: z.boolean(),
    }),
  );
  routes.get(
    "/admin/people/invites",
    invitations.doc,
    credential,
    async (c) => {
      const invites = await listInvites(as(c));
      return invitations.answer(c, {
        invites,
        email_ready: await emailReady(as(c)),
      });
    },
  );
  const resent = documented("Resend an invite", InviteLink, {
    errors: [404, 429],
  });
  routes.post(
    "/admin/people/invites/:id/resend",
    resent.doc,
    credential,
    async (c) => resent.answer(c, await resendInvite(as(c), c.req.param("id"))),
  );
  const revoked = removed("Revoke an invite", [404]);
  routes.delete(
    "/admin/people/invites/:id",
    revoked.doc,
    credential,
    async (c) => {
      await revokeInvite(as(c), c.req.param("id"));
      return revoked.answer(c);
    },
  );
  const role = removed("Set a person's direct role", [400, 404, 409]);
  routes.put(
    "/admin/people/:id/role",
    role.doc,
    credential,
    admitted("manage_people"),
    validator(
      "json",
      z.object({ role: z.enum(["viewer", "curator", "admin"]) }),
      refuse,
    ),
    async (c) => {
      await setPersonRole(as(c), c.req.param("id"), c.req.valid("json").role);
      return role.answer(c);
    },
  );
  const pii = removed("Set a person's PII reader access", [400, 404, 409]);
  routes.put(
    "/admin/people/:id/pii",
    pii.doc,
    credential,
    admitted("manage_people"),
    validator("json", z.object({ allowed: z.boolean() }), refuse),
    async (c) => {
      await setPiiReader(as(c), c.req.param("id"), c.req.valid("json").allowed);
      return pii.answer(c);
    },
  );
  for (const [action, summary, change] of [
    ["deactivate", "Deactivate a person", deactivatePerson],
    ["reactivate", "Reactivate a person", reactivatePerson],
    [
      "sign-out",
      "End a person's sessions and MCP and CLI grants",
      signOutPerson,
    ],
  ] as const) {
    const changed = removed(summary, [404, 409]);
    routes.post(
      `/admin/people/:id/${action}`,
      changed.doc,
      credential,
      async (c) => {
        await change(as(c), c.req.param("id"));
        return changed.answer(c);
      },
    );
  }
  const deleted = removed("Delete a person", [404, 409]);
  routes.delete("/admin/people/:id", deleted.doc, credential, async (c) => {
    await deletePerson(as(c), c.req.param("id"));
    return deleted.answer(c);
  });
  const image = { schema: { type: "string", format: "binary" } } as const;
  routes.put(
    "/admin/branding/logo",
    describeRoute({
      summary: "Store the brand logo",
      requestBody: {
        required: true,
        content: {
          "image/png": image,
          "image/jpeg": image,
          "image/webp": image,
        },
      },
      responses: {
        204: { description: "The logo is stored." },
        ...failures([400]),
      },
    }),
    credential,
    admitted("manage_settings"),
    async (c) => {
      await putLogo(as(c), new Uint8Array(await c.req.arrayBuffer()));
      return c.body(null, 204);
    },
  );
  const noLogo = removed("Remove the brand logo");
  routes.delete("/admin/branding/logo", noLogo.doc, credential, async (c) => {
    await deleteLogo(as(c));
    return noLogo.answer(c);
  });

  const people = documented(
    "Each person with their roles, where each comes from, and their Power BI connection",
    z.object({ people: z.array(Person) }),
  );
  routes.get("/admin/people", people.doc, credential, async (c) =>
    people.answer(c, { people: await listPeople(as(c)) }),
  );

  const Queued = z.object({ job_id: z.string(), queued: z.boolean() });
  const sync = (description: string) => ({
    description,
    content: { "application/json": { schema: resolver(Queued) } },
  });
  routes.post(
    "/admin/sync",
    describeRoute({
      summary: "Queue a sync now, unless one waits or runs",
      responses: {
        202: sync("A sync was queued."),
        200: sync("One already waits or runs, and this is its job."),
        ...failures([400]),
      },
    }),
    credential,
    validator(
      "json",
      z.strictObject({ kind: z.enum(SYNC_KINDS).default("incremental") }),
      refuse,
    ),
    async (c) => {
      const started = await startSync(as(c), c.req.valid("json").kind);
      return c.body(
        JSON.stringify(Queued.parse(started)),
        started.queued ? 202 : 200,
        {
          "Content-Type": "application/json",
        },
      );
    },
  );
  const runs = documented(
    "The newest sync runs",
    z.object({ runs: z.array(SyncRun) }),
    { errors: [400] },
  );
  routes.get(
    "/admin/sync",
    runs.doc,
    credential,
    validator(
      "query",
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      refuse,
    ),
    async (c) =>
      runs.answer(c, {
        runs: await listSyncRuns(as(c), c.req.valid("query").limit),
      }),
  );

  const accounts = documented(
    "Every service account",
    z.object({ service_accounts: z.array(ServiceAccount) }),
  );
  routes.get("/admin/service-accounts", accounts.doc, credential, async (c) =>
    accounts.answer(c, { service_accounts: await listServiceAccounts(as(c)) }),
  );
  const createAccount = documented("Create a service account", ServiceAccount, {
    status: 201,
    errors: [400, 409],
  });
  routes.post(
    "/admin/service-accounts",
    createAccount.doc,
    credential,
    validator("json", NewAccount, refuse),
    async (c) =>
      createAccount.answer(
        c,
        await createServiceAccount(as(c), c.req.valid("json")),
      ),
  );
  const patchAccount = documented(
    "Change a service account's fields, or disable or enable it",
    ServiceAccount,
    { errors: [400, 404] },
  );
  routes.patch(
    "/admin/service-accounts/:name",
    patchAccount.doc,
    credential,
    validator("param", ByName, refuse),
    validator("json", AccountChange, refuse),
    async (c) => {
      const { name } = c.req.valid("param");
      const change = c.req.valid("json");
      if (!("disabled" in change))
        return patchAccount.answer(
          c,
          await updateServiceAccount(as(c), name, change),
        );
      if (change.disabled) await disableServiceAccount(as(c), name);
      else await enableServiceAccount(as(c), name);
      return patchAccount.answer(c, await getServiceAccount(as(c), name));
    },
  );
  const deleteAccount = removed(
    "Delete a service account with its keys and results",
    [404],
  );
  routes.delete(
    "/admin/service-accounts/:name",
    deleteAccount.doc,
    credential,
    validator("param", ByName, refuse),
    async (c) => {
      await deleteServiceAccount(as(c), c.req.valid("param").name);
      return deleteAccount.answer(c);
    },
  );

  const keys = documented(
    "A service account's keys, never the keys themselves",
    z.object({ keys: z.array(ApiKey) }),
    { errors: [404] },
  );
  routes.get(
    "/admin/service-accounts/:name/keys",
    keys.doc,
    credential,
    validator("param", ByName, refuse),
    async (c) =>
      keys.answer(c, {
        keys: await listKeys(as(c), c.req.valid("param").name),
      }),
  );
  const newKey = documented(
    "Make a key. The answer holds the key once, and no other answer does",
    NewApiKey,
    { status: 201, errors: [400, 404, 409] },
  );
  routes.post(
    "/admin/service-accounts/:name/keys",
    newKey.doc,
    credential,
    validator("param", ByName, refuse),
    validator(
      "json",
      z.strictObject({ expires_in_days: z.number().int().min(1).max(90) }),
      refuse,
    ),
    async (c) =>
      newKey.answer(
        c,
        await createKey(as(c), c.req.valid("param").name, c.req.valid("json")),
      ),
  );
  const endKey = removed("Revoke a key at once", [404]);
  routes.delete(
    "/admin/service-accounts/:name/keys/:id",
    endKey.doc,
    credential,
    validator("param", z.object({ name: text, id: guid }), refuse),
    async (c) => {
      const { name, id } = c.req.valid("param");
      await revokeKey(as(c), name, id);
      return endKey.answer(c);
    },
  );

  const endGrant = removed("Revoke any person's MCP or CLI grant", [404]);
  routes.delete(
    "/admin/grants/:id",
    endGrant.doc,
    credential,
    validator("param", z.object({ id: text }), refuse),
    async (c) => {
      await revokeConnectionAs(as(c), c.req.valid("param").id);
      return endGrant.answer(c);
    },
  );

  const audit = documented(
    "The audit log, newest first",
    z.object({ events: z.array(AuditEvent) }),
    { errors: [400] },
  );
  routes.get(
    "/admin/audit",
    audit.doc,
    credential,
    validator(
      "query",
      z.object({
        since: iso.optional(),
        principal: text.optional(),
        action: text.optional(),
        before_id: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      refuse,
    ),
    async (c) => {
      const { since, ...query } = c.req.valid("query");
      return audit.answer(c, {
        events: await listAudit(as(c), {
          ...query,
          ...(since === undefined ? {} : { since: new Date(since) }),
        }),
      });
    },
  );

  const exported = documented(
    "The deployment as book.yml: settings, conventions, roles and service accounts, never a secret or a key",
    z.object({ yaml: z.string() }),
  );
  routes.get("/admin/export", exported.doc, credential, async (c) =>
    exported.answer(c, { yaml: await exportBook(as(c)) }),
  );
  const imported = documented(
    "Compare a book.yml with the deployment; with apply, make the changes",
    Import,
    { errors: [400, 409] },
  );
  routes.post(
    "/admin/import",
    imported.doc,
    credential,
    validator(
      "json",
      z.strictObject({
        yaml: z.string().max(256 * 1024),
        apply: z.boolean().default(false),
        save_failing: z.boolean().default(false),
      }),
      refuse,
    ),
    async (c) => {
      const { yaml, ...options } = c.req.valid("json");
      return imported.answer(c, await importBook(as(c), yaml, options));
    },
  );

  return routes;
}
