import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LineCounter, parseDocument, stringify, visit } from "yaml";
import { z } from "zod";
import type {
  ServiceContext,
  SettingKey,
  SettingValue,
} from "../../context.js";
import { PII_RULE_KINDS, type PiiRuleKind } from "../../db/schema/pii.js";
import { ServiceError } from "../../errors.js";
import { isShippedRole } from "../access/shipped-roles.js";
import { listAssignments, type RoleAssignment } from "../auth/roles.js";
import {
  auditServiceAccount,
  changeServiceAccount,
  insertServiceAccount,
  listServiceAccounts,
} from "../auth/service-accounts.js";
import { BOOK } from "../book/changes.js";
import {
  conventionsInForce,
  diffConventions,
  resolve,
  setConventions,
} from "../conventions/store.js";
import { auditRuleSet, foldNames, listRules, saveRule } from "../pii/rules.js";
import { describeIssues } from "../settings/registry.js";
import { inSignInConfig, signInConfigChanged } from "../auth/sign-in-config.js";
import { inTransaction } from "../settings/store.js";
import type { CheckResult } from "./checks.js";
import { audited, requireAdmin } from "./guard.js";
import { assignmentDetail, insertAssignment, lockAsAdmin } from "./people.js";
import {
  checkSetting,
  parseSetting,
  refuseFailing,
  saveSetting,
} from "./settings.js";

/*
 * book.yml, format 1, a public interface, never holding a secret or a key.
 * book.schema.json, shipped for the CLI, is bookSchema as JSON Schema; a test
 * keeps them the same. Settings and conventions have their own schemas.
 * The conventions travel in conventions.yml beside it; an import still takes
 * a book.yml that holds them, and an export leaves them out.
 */

// custom: a role the deployment's own policies name, assigned on purpose.
const role = { role: z.string(), custom: z.literal(true).optional() };
const assignmentSchema = z.discriminatedUnion("subject_kind", [
  z.strictObject({
    ...role,
    subject_kind: z.enum(["person", "email_domain"]),
    subject: z.string(),
  }),
  z.strictObject({
    ...role,
    subject_kind: z.literal("group"),
    provider: z.string(),
    subject: z.string(),
  }),
  z.strictObject({ ...role, subject_kind: z.literal("everyone_in_tenant") }),
]);
type BookAssignment = z.infer<typeof assignmentSchema>;
const strings = z.array(z.string());
const account = {
  name: z.string(),
  owner_email: z.string(),
  roles: strings,
  workspace_ids: strings,
  app_ids: strings,
  source_cidrs: strings,
  max_key_age_days: z.number().int(),
};
const document = z.record(z.string(), z.unknown()).optional();
// The limits setRule enforces, so the preview refuses what apply would.
const trimmed = (value: string | null | undefined) =>
  value == null || value === value.trim();
const noNul = (value: string | null | undefined) =>
  value == null || !value.includes("\0");
const piiRuleSchema = z
  .strictObject({
    kind: z.enum(PII_RULE_KINDS),
    table: z.string().min(1).max(200),
    name: z.string().min(1).max(200).nullable().optional(),
    pii: z.boolean(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((rule) => (rule.kind === "table") === (rule.name == null), {
    message: "a table rule takes no name and the other kinds need one",
  })
  .refine((rule) => trimmed(rule.table) && trimmed(rule.name), {
    message: "a table or name has leading or trailing whitespace",
  })
  .refine((rule) => noNul(rule.table) && noNul(rule.name) && noNul(rule.note), {
    message: "a table, name or note holds a null character",
  });
type BookPiiRule = {
  kind: PiiRuleKind;
  table: string;
  name: string | null;
  pii: boolean;
  note: string | null;
};
export const bookSchema = z.strictObject({
  format: z.literal(1),
  settings: document,
  conventions: document,
  role_assignments: z.array(assignmentSchema).optional(),
  service_accounts: z.array(z.strictObject(account)).optional(),
  pii_rules: z.array(piiRuleSchema).optional(),
});

const entryOf = ({ role, subject_kind, provider, subject }: RoleAssignment) =>
  assignmentSchema.parse({
    role,
    ...(isShippedRole(role) ? {} : { custom: true }),
    subject_kind,
    ...(provider === null ? {} : { provider }),
    ...(subject === null ? {} : { subject }),
  });
/** Who holds which role: custom says how it was assigned, and emails and domains are kept in lower case. */
function keyOf(entry: BookAssignment): string {
  const { role, subject_kind } = entry;
  if (subject_kind === "everyone_in_tenant") return `${role} ${subject_kind}`;
  if (subject_kind === "group")
    return `${role} group ${entry.provider} ${entry.subject}`;
  return `${role} ${subject_kind} ${entry.subject.toLowerCase()}`;
}

const bytes = (a: string | null, b: string | null) =>
  (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

/** In the file's shape, ordered by kind, table, name. */
async function currentRules(context: ServiceContext): Promise<BookPiiRule[]> {
  return (await listRules(context, {}))
    .map(({ kind, table_name, name, pii, note }) => ({
      kind,
      table: table_name,
      name,
      pii,
      note,
    }))
    .sort(
      (a, b) =>
        bytes(a.kind, b.kind) ||
        bytes(a.table, b.table) ||
        bytes(a.name, b.name),
    );
}

type RuleName = { kind: string; table: string; name: string | null };

/** What the unique index compares: the kind, and the table and name folded as setRule stores them. */
async function ruleKeys(
  context: ServiceContext,
  rules: RuleName[],
): Promise<string[]> {
  if (rules.length === 0) return [];
  const folded = await foldNames(
    context.db,
    rules.flatMap((r) => [
      r.table.normalize("NFC"),
      r.name?.normalize("NFC") ?? "",
    ]),
  );
  return rules.map((r, i) =>
    JSON.stringify([r.kind, folded[2 * i], folded[2 * i + 1]]),
  );
}

const ruleLabel = ({ kind, table, name }: RuleName) =>
  kind === "table" ? `table:${table}` : `${kind}:${table}[${name ?? ""}]`;

/** Only the setup's checks write setup.*, so a deployment's setup state never travels. */
const exported = (key: string) => !key.startsWith("setup.");

async function currentBook(context: ServiceContext) {
  const accounts = await listServiceAccounts(context);
  return {
    format: 1 as const,
    settings: Object.fromEntries(
      (await context.settings.list())
        .filter((s) => s.source === "database" && exported(s.key))
        .map((listing) => [listing.key, listing.value]),
    ),
    role_assignments: (await listAssignments(context.db))
      .map(entryOf)
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
    // Picked by the schema, so neither a key nor any other column leaves.
    service_accounts: accounts.map((row) => z.object(account).parse(row)),
    pii_rules: await currentRules(context),
  };
}

export async function exportBook(context: ServiceContext): Promise<string> {
  await requireAdmin(context, "export_book");
  return stringify(await currentBook(context));
}

const MAX_BYTES = 256 * 1024;

/** Plain YAML only: no aliases (so no billion laughs), no merge keys, no tags it does not know. */
function readBook(yaml: string) {
  if (Buffer.byteLength(yaml) > MAX_BYTES)
    throw new ServiceError("invalid", "book.yml is larger than 256 KiB.");
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, {
    merge: false,
    prettyErrors: false,
    lineCounter,
  });
  const at = [...document.errors, ...document.warnings].map((p) => p.pos[0]);
  visit(document, {
    Alias: (_key, node) => void at.push(node.range?.[0] ?? 0),
  });
  const [first] = at.sort((a, b) => a - b);
  if (first !== undefined) {
    const { line, col } = lineCounter.linePos(first);
    throw new ServiceError(
      "invalid",
      `book.yml cannot be read at line ${String(line)}, column ${String(col)}: it takes plain YAML, without aliases or tags.`,
    );
  }
  const parsed = bookSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success)
    throw new ServiceError(
      "invalid",
      `book.yml is not valid: ${describeIssues(parsed.error)}.`,
    );
  return parsed.data;
}

export type BookChange = {
  path: string;
  before: unknown;
  after: unknown;
  /** A changed setting's check, run on the file's value. */
  check?: CheckResult | null;
};

/**
 * Validates the file and answers how it differs from the deployment, with
 * each changed setting's check, and what the deployment holds that the file
 * lacks (`kept`, which stays). With apply, makes the changes in one
 * transaction, refusing a setting that fails its check unless save_failing.
 * A PII rule is matched under the fold the database compares by, so
 * `customer[email]` in the file is the held `Customer[Email]`; rules the
 * file lacks are kept, never removed.
 * Conventions in the file replace the deployment's whole: a key left out
 * falls back to the preset, and the changes show it. A company part is
 * stored as given; a complete document, from before the company's part was
 * stored, as what differs from its preset.
 */
export async function importBook(
  context: ServiceContext,
  yaml: string,
  options: { apply: boolean; save_failing?: boolean },
) {
  await requireAdmin(context, "import_book");
  const file = readBook(yaml);
  const current = await currentBook(context);
  const listed = new Map(
    (await context.settings.list()).map((s) => [s.key, s]),
  );
  const settings: {
    key: SettingKey;
    value: SettingValue<SettingKey>;
    before: unknown;
    check: CheckResult | null;
  }[] = [];
  for (const [key, value] of Object.entries(file.settings ?? {})) {
    const setting = parseSetting(key, value);
    const before = listed.get(setting.key);
    if (before?.source === "environment")
      throw new ServiceError(
        "conflict",
        `${key} is set by the environment, so book.yml cannot change it.`,
      );
    if (isDeepStrictEqual(before?.value, setting.value)) continue;
    const check = await checkSetting(context, setting.key, setting.value);
    settings.push({ ...setting, before: before?.value ?? null, check });
  }
  const inForce = (await conventionsInForce(context.db)).conventions;
  const conventions =
    file.conventions === undefined
      ? []
      : diffConventions(inForce, resolve(file.conventions));
  const inFile = new Set((file.role_assignments ?? []).map(keyOf));
  const held = new Set(current.role_assignments.map(keyOf));
  const assignments = (file.role_assignments ?? []).filter(
    (entry) => !held.has(keyOf(entry)),
  );
  const existing = new Map(current.service_accounts.map((a) => [a.name, a]));
  const accounts = (file.service_accounts ?? []).filter(
    (account) => !isDeepStrictEqual(existing.get(account.name), account),
  );
  const fileRules = (file.pii_rules ?? []).map((rule) => ({
    ...rule,
    name: rule.name ?? null,
    note: rule.note ?? null,
  }));
  const fileKeys = await ruleKeys(context, fileRules);
  if (new Set(fileKeys).size < fileKeys.length)
    throw new ServiceError(
      "invalid",
      "book.yml names a PII rule twice, in spellings that match.",
    );
  const heldKeys = await ruleKeys(context, current.pii_rules);
  const heldRules = new Map(heldKeys.map((k, i) => [k, current.pii_rules[i]]));
  const ruleChanges = fileRules.flatMap((rule, i) => {
    const held = heldRules.get(fileKeys[i] ?? "") ?? null;
    return held?.pii === rule.pii && held.note === rule.note
      ? []
      : [{ rule, held }];
  });
  // Each kind of change needs its own admin action, beside import_book.
  if (settings.length > 0) await requireAdmin(context, "manage_settings");
  if (assignments.length > 0) await requireAdmin(context, "manage_people");
  if (accounts.length > 0)
    await requireAdmin(context, "manage_service_accounts");
  if (conventions.length > 0)
    await context.access.require(context.principal, BOOK, "edit_conventions");
  if (ruleChanges.length > 0) await requireAdmin(context, "manage_pii");
  const change = (path: string, before: unknown, after: unknown) => ({
    path,
    before,
    after,
  });
  const changes: BookChange[] = [
    ...settings.map((s) => ({
      ...change(`settings.${s.key}`, s.before, s.value),
      check: s.check,
    })),
    ...conventions.map((c) =>
      change(`conventions.${c.path}`, c.before, c.after),
    ),
    ...assignments.map((a) => change("role_assignments", null, a)),
    ...accounts.map((a) =>
      change(`service_accounts.${a.name}`, existing.get(a.name) ?? null, a),
    ),
    ...ruleChanges.map(({ rule, held }) =>
      change(`pii_rules.${ruleLabel(rule)}`, held, rule),
    ),
  ];
  const names = new Set((file.service_accounts ?? []).map((a) => a.name));
  const kept = {
    settings: Object.keys(current.settings).filter(
      (key) => !Object.hasOwn(file.settings ?? {}, key),
    ),
    role_assignments: current.role_assignments.filter(
      (entry) => !inFile.has(keyOf(entry)),
    ),
    service_accounts: [...existing.keys()].filter((name) => !names.has(name)),
    pii_rules: current.pii_rules.filter(
      (_, i) => !fileKeys.includes(heldKeys[i] ?? ""),
    ),
  };
  if (!options.apply || changes.length === 0)
    return { changes, kept, applied: false };
  for (const s of settings) refuseFailing(s.key, s.check, options);

  const import_id = randomUUID();
  const paths = changes.map(({ path }) => path);
  // Each change's audit line, written once the transaction commits.
  const lines: (() => Promise<void>)[] = [];
  try {
    await context.db.transaction(async (tx) => {
      const settingsInTx = inTransaction(context.settings, tx);
      const inTx = { ...context, db: tx, settings: settingsInTx };
      for (const { key, value, before, check } of settings) {
        const ended = await saveSetting(inTx, key, value, check);
        const detail = {
          before,
          after: value,
          check_status: check?.status ?? null,
          ...ended,
        };
        const resource = { kind: "setting", id: key };
        lines.push(() =>
          audited(context, "setting.set", resource, { ...detail, import_id }),
        );
      }
      // The default role is read through this transaction, before the lock.
      if (assignments.length > 0)
        await lockAsAdmin(
          inTx,
          tx,
          await settingsInTx.get("access.default_role"),
        );
      for (const { custom, ...assignment } of assignments) {
        const row = await insertAssignment(inTx, assignment, { custom });
        const resource = { kind: "role_assignment", id: row.id };
        const detail = { ...assignmentDetail(row), import_id };
        lines.push(() => audited(context, "role.assign", resource, detail));
      }
      for (const { name, ...input } of accounts) {
        const action = existing.has(name) ? "update" : "create";
        const { fields } = await (existing.has(name)
          ? changeServiceAccount(inTx, name, input)
          : insertServiceAccount(inTx, { name, ...input }));
        const detail = { ...fields, import_id };
        lines.push(() => auditServiceAccount(context, action, name, detail));
      }
      // Last: the conventions' event is written under the feed's lock.
      // edit_conventions was checked above: Cerbos reads a setting through
      // the pool, and this transaction may hold the admin lock.
      if (conventions.length > 0 && file.conventions !== undefined) {
        const { version } = await setConventions(
          inTx,
          inTx.principal,
          file.conventions,
        );
        const resource = { kind: "conventions", id: String(version) };
        lines.push(() =>
          audited(context, "conventions.set", resource, { import_id }),
        );
      }
      // manage_pii was checked above; the audit line waits for the commit.
      for (const { rule } of ruleChanges) {
        const saved = await saveRule(inTx, {
          kind: rule.kind,
          table_name: rule.table,
          name: rule.name,
          pii: rule.pii,
          note: rule.note,
        });
        lines.push(() => auditRuleSet(context, saved, { import_id }));
      }
    });
  } catch (error) {
    const error_kind = error instanceof ServiceError ? error.kind : "internal";
    const resource = { kind: "book", id: "book.yml" };
    await audited(
      context,
      "book.import",
      resource,
      { import_id, paths, error_kind },
      "rolled back",
    );
    throw error;
  }
  if (settings.some(({ key }) => inSignInConfig(key)))
    signInConfigChanged(context.db);
  // Written once the rows are, so the audit names only what was committed.
  for (const line of lines) await line();
  const resource = { kind: "book", id: "book.yml" };
  await audited(context, "book.import", resource, { import_id, paths });
  return { changes, kept, applied: true };
}
