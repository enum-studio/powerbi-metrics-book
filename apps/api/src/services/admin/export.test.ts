import { readFileSync } from "node:fs";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
  adminOnRecord,
  ADMINS_DOMAIN,
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { publishedIdentities } from "../../../test/secrets-support.js";
import { auditEvent } from "../../db/schema/audit.js";
import { createServiceAccount } from "../auth/service-accounts.js";
import { signInConfigReader } from "../auth/sign-in-config.js";
import { setConventionsAsAdmin } from "../conventions/service.js";
import { listRules, setRule } from "../pii/rules.js";
import { createSettingsStore, inTransaction } from "../settings/store.js";
import { registerCheck } from "./checks.js";
import { bookSchema, exportBook, importBook } from "./export.js";
import { assignRole } from "./people.js";
import { setSecret } from "./secrets.js";
import { setSetting } from "./settings.js";

afterAll(closeTestPools);

const base = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = {
  ...base,
  settings: createSettingsStore(base.db, {}),
  principal: await adminOnRecord(base),
};
const VALUE = "sk-test-export-never-0001";

/** A deployment's export, made in a transaction that is rolled back, so the database stays empty. */
async function exportedDeployment(): Promise<string> {
  let exported = "";
  const done = admin.db.transaction(async (tx) => {
    const deployment = {
      ...admin,
      db: tx,
      settings: createSettingsStore(tx, {}),
    };
    await publishedIdentities(tx);
    await setSecret(deployment, "openai_api_key", VALUE, { expires_at: null });
    await setSetting(deployment, "results.ttl_hours", 48, {
      save_failing: false,
    });
    const person = {
      subject_kind: "person",
      subject: "ada@example.test",
    } as const;
    await assignRole(deployment, { role: "admin", ...person });
    await assignRole(
      deployment,
      { role: "analyst", ...person },
      {
        custom: true,
      },
    );
    await assignRole(deployment, {
      role: "viewer",
      subject_kind: "everyone_in_tenant",
    });
    await createServiceAccount(deployment, {
      name: "sa_export",
      owner_email: "owner@example.test",
      roles: ["viewer"],
      workspace_ids: ["7d8f0a52-9a43-4bd5-8f5e-2b8e64c1f0a1"],
    });
    await setConventionsAsAdmin(deployment, { preset: "minimal" });
    await setRule(deployment, {
      kind: "table",
      table_name: "Staff",
      pii: true,
    });
    await setRule(deployment, {
      kind: "measure",
      table_name: "Customer",
      name: "Total Spend",
      pii: false,
    });
    await setRule(deployment, {
      kind: "column",
      table_name: "Customer",
      name: "Email",
      pii: true,
      note: "Contact address",
    });
    exported = await exportBook(deployment);
    tx.rollback();
  });
  await done.catch((error: unknown) => {
    if (!(error instanceof TransactionRollbackError)) throw error;
  });
  return exported;
}

describe("book.yml", () => {
  it("ships book.schema.json as the schema the import checks", () => {
    const file = new URL("book.schema.json", import.meta.url);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      z.toJSONSchema(bookSchema),
    );
  });

  it("exports then imports into an empty database, showing the difference first, and exports the same", async () => {
    const exported = await exportedDeployment();
    expect(exported).not.toContain(VALUE);
    const { role_assignments, ...book } = bookSchema.parse(parse(exported));
    // The caller is an admin on record (test/deps.ts adminOnRecord).
    expect(
      role_assignments?.filter(
        (a) => !("subject" in a) || !a.subject.endsWith(`@${ADMINS_DOMAIN}`),
      ),
    ).toMatchObject([
      { role: "admin", subject_kind: "person" },
      { role: "analyst", custom: true },
      { role: "viewer", subject_kind: "everyone_in_tenant" },
    ]);
    expect(book).toMatchObject({
      format: 1,
      settings: { "results.ttl_hours": 48 },
      conventions: { preset: "minimal" },
      service_accounts: [{ name: "sa_export", max_key_age_days: 90 }],
      pii_rules: [
        {
          kind: "column",
          table: "Customer",
          name: "Email",
          pii: true,
          note: "Contact address",
        },
        { kind: "measure", table: "Customer", name: "Total Spend", pii: false },
        { kind: "table", table: "Staff", name: null, pii: true, note: null },
      ],
    });
    expect(exported).not.toContain("set_by");
    const shown = await importBook(admin, exported, { apply: false });
    expect(shown.applied).toBe(false);
    expect(shown.changes.map((change) => change.path)).toEqual(
      expect.arrayContaining([
        "settings.results.ttl_hours",
        "conventions.preset",
        "role_assignments",
        "service_accounts.sa_export",
        "pii_rules.column:Customer[Email]",
        "pii_rules.measure:Customer[Total Spend]",
        "pii_rules.table:Staff",
      ]),
    );
    expect(await exportBook(admin)).not.toEqual(exported);
    expect(await importBook(admin, exported, { apply: true })).toMatchObject({
      applied: true,
    });
    expect(await exportBook(admin)).toEqual(exported);
    const none = {
      settings: [],
      role_assignments: [],
      service_accounts: [],
      pii_rules: [],
    };
    expect(await importBook(admin, exported, { apply: true })).toEqual({
      changes: [],
      kept: none,
      applied: false,
    });
    // One import's audit lines share its id, written after it committed.
    const lines = await admin.db.select().from(auditEvent);
    const done = lines.find((l) => l.action === "admin.book.import");
    const id = done?.detail.import_id;
    expect(
      lines
        .filter((l) => l.detail.import_id === id)
        .map((l) => l.action)
        .sort(),
    ).toEqual([
      "admin.book.import",
      "admin.conventions.set",
      ...Array<string>(3).fill("admin.pii_rule.set"),
      ...Array<string>(3).fill("admin.role.assign"),
      "admin.setting.set",
      "service_account.create",
    ]);
  });

  it("runs a changed setting's check in the preview, refuses a failing one unless save_failing, and lists what it keeps", async () => {
    registerCheck("queries.rate_per_minute", (_deps, value) =>
      Promise.resolve(
        value === 500
          ? { status: "failing", message: "Too many." }
          : { status: "passing", message: null },
      ),
    );
    const file = "format: 1\nsettings:\n  queries.rate_per_minute: 500\n";
    const shown = await importBook(admin, file, { apply: false });
    expect(shown.changes[0]?.check).toEqual({
      status: "failing",
      message: "Too many.",
    });
    expect(shown.kept.service_accounts).toEqual(["sa_export"]);
    await expect(
      importBook(admin, file, { apply: true }),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
    await importBook(admin, file, { apply: true, save_failing: true });
    expect(await admin.settings.get("queries.rate_per_minute")).toBe(500);
    // The transaction's store keeps the app's environment.
    const set = createSettingsStore(admin.db, { QUERIES_RATE_PER_MINUTE: "5" });
    await expect(
      inTransaction(set, admin.db).set(
        "queries.rate_per_minute",
        9,
        principals.admin,
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("rolls a failing import back whole, with one audit line saying so", async () => {
    const file = [
      "format: 1",
      "role_assignments: [{ role: curator, subject_kind: person, subject: rolled@example.test }]",
      "service_accounts:",
      "  - { name: sa_rolled, owner_email: o@example.test, roles: [viewer], workspace_ids: [], app_ids: [], source_cidrs: [], max_key_age_days: 30 }",
      "  - { name: sa_admin, owner_email: o@example.test, roles: [admin], workspace_ids: [], app_ids: [], source_cidrs: [], max_key_age_days: 30 }",
    ].join("\n");
    await expect(
      importBook(admin, file, { apply: true }),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
    const lines = await admin.db.select().from(auditEvent);
    const rolled = lines.filter((l) => l.reason === "rolled back");
    expect(rolled).toMatchObject([
      { action: "admin.book.import", detail: { error_kind: "invalid" } },
    ]);
    const import_id = rolled[0]?.detail.import_id;
    expect(lines.filter((l) => l.detail.import_id === import_id)).toHaveLength(
      1,
    );
    // sa_rolled was made, then rolled back with the rest: no line names it.
    expect(lines.filter((l) => l.resource_id === "sa_rolled")).toEqual([]);
    const after = await exportBook(admin);
    expect(after).not.toContain("rolled@");
    expect(after).not.toContain("sa_rolled");
  });

  it("refuses a file that is not format 1, a role no rule allows, a setup key, and YAML beyond plain", async () => {
    for (const file of [
      "format: 2",
      "format: 1\nrole_assignments:\n  - { role: curater, subject_kind: everyone_in_tenant }",
      "format: 1\nrole_assignments:\n  - { role: admin, subject_kind: everyone_in_tenant }",
      "format: 1\nsettings: { setup.completed_at: '2026-10-25' }",
      `format: 1\n#${"x".repeat(256 * 1024)}`,
    ])
      await expect(
        importBook(admin, file, { apply: true }),
      ).rejects.toMatchObject({ kind: "invalid" });
    for (const file of [
      "format: 1\na: &a [x, x]\nb: &b [*a, *a]\nc: [*b, *b]",
      "format: 1\nsettings: { search.model: !!js/function 'f' }",
      "format: 1\nsettings: { search.model: [ }",
    ])
      await expect(importBook(admin, file, { apply: true })).rejects.toThrow(
        /^book.yml cannot be read at line \d+, column \d+/,
      );
  });

  it("refuses a token's file that changes a trust rule, and applies nothing else from it", async () => {
    const token = {
      ...admin,
      principal: { ...principals.admin, via: "cli" as const },
    };
    const before = await exportBook(admin);
    const file = [
      "format: 1",
      "settings: { results.ttl_hours: 36 }",
      "role_assignments: [{ role: curator, subject_kind: person, subject: token-import@example.test }]",
      "service_accounts:",
      "  - { name: sa_token_import, owner_email: o@example.test, roles: [viewer], workspace_ids: [], app_ids: [], source_cidrs: [], max_key_age_days: 30 }",
      "conventions: { trust: { human_verify_from: any } }",
    ].join("\n");
    await expect(
      importBook(token, file, { apply: true }),
    ).rejects.toMatchObject({
      kind: "refused",
    });
    const after = await exportBook(admin);
    expect(after).toEqual(before);
    expect(after).not.toContain("token-import@");
    expect(after).not.toContain("sa_token_import");
    expect(after).not.toContain("human_verify_from: any");
  });

  it("refuses a curator both", async () => {
    const curator = { ...admin, principal: principals.curator };
    await expect(exportBook(curator)).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(
      importBook(curator, "format: 1", { apply: false }),
    ).rejects.toMatchObject({ kind: "refused" });
    const rules =
      "format: 1\npii_rules: [{ kind: table, table: Staff, pii: true }]";
    await expect(
      importBook(curator, rules, { apply: true }),
    ).rejects.toMatchObject({ kind: "refused" });
  });
});

/** The work runs in a transaction that is rolled back, so the rules it sets are gone after. */
async function inRolledBackBook(
  work: (deployment: typeof admin) => Promise<void>,
) {
  const done = admin.db.transaction(async (tx) => {
    await work({ ...admin, db: tx, settings: createSettingsStore(tx, {}) });
    tx.rollback();
  });
  await done.catch((error: unknown) => {
    if (!(error instanceof TransactionRollbackError)) throw error;
  });
}

const rule = (extra: string) =>
  `format: 1\npii_rules:\n  - { kind: column, table: Orders, name: Ship To, ${extra} }`;

describe("book.yml pii_rules", () => {
  it("shows an add and a change by the rule's folded name, applies both and keeps a rule the file lacks", async () => {
    await inRolledBackBook(async (deployment) => {
      await setRule(deployment, {
        kind: "column",
        table_name: "Orders",
        name: "Ship To",
        pii: false,
      });
      await setRule(deployment, {
        kind: "table",
        table_name: "Audit Only",
        pii: true,
      });
      const file = [
        "format: 1",
        "pii_rules:",
        // The same rule as Orders[Ship To], spelled another way, now PII.
        "  - { kind: column, table: ORDERS, name: ship to, pii: true, note: Address }",
        "  - { kind: measure, table: Orders, name: Margin, pii: false }",
      ].join("\n");
      const shown = await importBook(deployment, file, { apply: false });
      expect(shown.changes.map((c) => c.path)).toEqual([
        "pii_rules.column:ORDERS[ship to]",
        "pii_rules.measure:Orders[Margin]",
      ]);
      expect(shown.changes[0]).toMatchObject({
        before: { pii: false, note: null },
        after: { pii: true, note: "Address" },
      });
      expect(shown.changes[1]?.before).toBeNull();
      expect(shown.kept.pii_rules).toContainEqual({
        kind: "table",
        table: "Audit Only",
        name: null,
        pii: true,
        note: null,
      });
      await importBook(deployment, file, { apply: true });
      const rules = (await listRules(deployment, {})).filter((r) =>
        ["orders", "audit only"].includes(r.table_name.toLowerCase()),
      );
      expect(rules.map((r) => [r.kind, r.table_name, r.name, r.pii])).toEqual([
        ["table", "Audit Only", null, true],
        ["column", "ORDERS", "ship to", true],
        ["measure", "Orders", "Margin", false],
      ]);
      // Spelled yet another way, the same rules are no change, and the table rule is still kept.
      const respelled = file
        .replace("ORDERS", "orders")
        .replace("ship to", "SHIP TO");
      const again = await importBook(deployment, respelled, { apply: false });
      expect(again.changes).toEqual([]);
      expect(again.kept.pii_rules.map((r) => r.table)).toEqual(
        expect.arrayContaining(["Audit Only"]),
      );
    });
  });

  it("refuses a rule the route would refuse, and a kind or field it does not know", async () => {
    for (const file of [
      rule("pii: true, set_by_id: x"),
      "format: 1\npii_rules: [{ kind: row, table: Orders, name: A, pii: true }]",
      "format: 1\npii_rules: [{ kind: table, table: Orders, name: A, pii: true }]",
      "format: 1\npii_rules: [{ kind: column, table: Orders, pii: true }]",
      `format: 1\npii_rules: [{ kind: table, table: ${"x".repeat(201)}, pii: true }]`,
      "format: 1\npii_rules: [{ kind: column, table: ' Orders', name: A, pii: true }]",
      rule(`pii: true, note: ${"n".repeat(501)}`),
    ])
      await expect(
        importBook(admin, file, { apply: true }),
      ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses a null character in a table, name or note as invalid, in the preview too", async () => {
    for (const file of [
      'format: 1\npii_rules: [{ kind: column, table: "Or\\0ders", name: A, pii: true }]',
      'format: 1\npii_rules: [{ kind: column, table: Orders, name: "A\\0", pii: true }]',
      'format: 1\npii_rules: [{ kind: table, table: Orders, pii: true, note: "n\\0" }]',
    ])
      await expect(
        importBook(admin, file, { apply: false }),
      ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("audits an import's rules after it commits, with its import_id", async () => {
    await inRolledBackBook(async (deployment) => {
      const file = [
        "format: 1",
        "pii_rules:",
        "  - { kind: table, table: Audit Import One, pii: true }",
        "  - { kind: column, table: Audit Import One, name: Email, pii: true }",
      ].join("\n");
      await importBook(deployment, file, { apply: true });
      const lines = await deployment.db.select().from(auditEvent);
      const done = lines.find(
        (l) =>
          l.action === "admin.book.import" &&
          JSON.stringify(l.detail.paths).includes("Audit Import One"),
      );
      const sets = lines.filter(
        (l) =>
          l.action === "admin.pii_rule.set" &&
          l.detail.import_id === done?.detail.import_id,
      );
      expect(done?.detail.import_id).toBeDefined();
      expect(sets).toHaveLength(2);
    });
  });

  it("leaves no audit line for a rule saved before another one failed", async () => {
    // Composed, U+0344 doubles in length, so 101 of them pass the file's limit and fail the rule's.
    const long = "̈́".repeat(101);
    const file = [
      "format: 1",
      "pii_rules:",
      "  - { kind: table, table: Audit Rolled Back, pii: true }",
      `  - { kind: column, table: Audit Rolled Back, name: "${long}", pii: true }`,
    ].join("\n");
    await expect(
      importBook(admin, file, { apply: true }),
    ).rejects.toMatchObject({ kind: "invalid" });
    const lines = await admin.db.select().from(auditEvent);
    expect(
      lines.filter(
        (l) =>
          l.action === "admin.pii_rule.set" &&
          JSON.stringify(l.detail).includes("Audit Rolled Back"),
      ),
    ).toEqual([]);
    expect(await exportBook(admin)).not.toContain("Audit Rolled Back");
  });
});

it("refreshes the cached sign-in brand once an import commits", async () => {
  const read = signInConfigReader(admin);
  expect(await read()).toMatchObject({
    brand: { name: "Power BI Metrics Book" },
  });
  await importBook(
    admin,
    "format: 1\nsettings:\n  branding.name: Sample brand\n",
    {
      apply: true,
    },
  );
  expect(await read()).toMatchObject({ brand: { name: "Sample brand" } });
});
