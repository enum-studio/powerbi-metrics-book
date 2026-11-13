import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySecrets, MemorySettings } from "../../../test/doubles.js";
import { publishedIdentities } from "../../../test/secrets-support.js";
import { settingCheck } from "../../db/schema/admin.js";
import { auditEvent } from "../../db/schema/audit.js";
import { user } from "../../db/schema/auth.js";
import { secret, secret_ciphertext } from "../../db/schema/secrets.js";
import { createSettingsStore } from "../settings/store.js";
import { type Check, registerCheck, runCheck } from "./checks.js";
import { exportBook, importBook } from "./export.js";
import { listSecrets, setSecret, setSecretExpiry } from "./secrets.js";
import { listSettings, setSetting } from "./settings.js";
import { adminStatus } from "./status.js";

afterAll(closeTestPools);

const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = { ...deps, principal: principals.admin };
const curator = { ...deps, principal: principals.curator };
const VALUE = "sk-test-abcd1234";

beforeAll(() => publishedIdentities(deps.db));

describe("secrets in the admin section", () => {
  it("lists a saved secret by its hint, with no field holding its value", async () => {
    await setSecret(admin, "openai_api_key", VALUE, { expires_at: null });
    const listed = await listSecrets(admin);
    expect(listed.find((s) => s.name === "openai_api_key")).toMatchObject({
      set: true,
      hint: "1234",
      set_by: "a removed person",
      readers: ["api", "worker"],
    });
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    const [audit] = await deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "admin.secret.set"));
    expect(audit?.resource_id).toBe("openai_api_key");
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it("changes only a saved secret's date, audits it, and refuses a person who is no admin", async () => {
    const name = "gemini_api_key";
    await setSecret(admin, name, VALUE, { expires_at: null });
    const rows = () =>
      Promise.all([
        deps.db.select().from(secret).where(eq(secret.name, name)),
        deps.db
          .select()
          .from(secret_ciphertext)
          .where(eq(secret_ciphertext.name, name)),
      ]);
    const [[before], ciphertexts] = await rows();
    const date = new Date("2027-06-30T23:59:59Z");
    await expect(setSecretExpiry(curator, name, date)).rejects.toThrow();
    const saved = await setSecretExpiry(admin, name, date);
    expect(saved.expires_at).toEqual(date);
    const [[after], ciphertextsAfter] = await rows();
    expect(after).toEqual({ ...before, expires_at: date });
    expect(ciphertextsAfter).toEqual(ciphertexts);
    const audits = await deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "admin.secret.expiry_set"));
    expect(audits.at(-1)?.resource_id).toBe(name);
    expect(JSON.stringify(audits)).not.toContain(VALUE);
  });

  it("lists a saved sign-in provider's secret as not set, so there is a row to set it in, and drops it with the provider", async () => {
    const stored = { ...admin, settings: createSettingsStore(deps.db, {}) };
    const provider = {
      id: "listed_probe",
      kind: "google" as const,
      label: "Listed probe",
      client_id: "client",
      issuer: null,
    };
    const name = "sign_in_listed_probe_client_secret";
    expect((await listSecrets(stored)).some((s) => s.name === name)).toBe(
      false,
    );
    await setSetting(stored, "sign_in.providers", [provider], {
      save_failing: true,
    });
    expect((await listSecrets(stored)).find((s) => s.name === name)).toEqual({
      name,
      readers: ["api"],
      set: false,
      needs_reentry_for: [],
      hint: null,
      set_by: null,
      set_at: null,
      expires_at: null,
      checked_at: null,
      check_status: null,
      check_message: null,
    });
    await setSetting(stored, "sign_in.providers", [], { save_failing: true });
    expect((await listSecrets(stored)).some((s) => s.name === name)).toBe(
      false,
    );
  });

  it("names who set a secret, never by a raw id", async () => {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await deps.db.insert(user).values({ id, name: "Setter", email });
    const setAs = (who: string) =>
      setSecret(
        { ...admin, principal: { ...principals.admin, id: who } },
        "openai_api_key",
        VALUE,
        { expires_at: null },
      );
    const setBy = async () =>
      (await listSecrets(admin)).find((s) => s.name === "openai_api_key")
        ?.set_by;

    await setAs(id);
    expect(await setBy()).toBe(email);
    await setAs("setup_link");
    expect(await setBy()).toBe("the setup link");
    await setAs(randomUUID());
    expect(await setBy()).toBe("a removed person");
    await deps.db
      .update(secret)
      .set({ set_by: null })
      .where(eq(secret.name, "openai_api_key"));
    expect(await setBy()).toBe("the stack");
  });

  it("runs the secret's check after saving it, and keeps its expiry", async () => {
    registerCheck("gemini_api_key", () =>
      Promise.resolve({ status: "failing", message: "The key was refused." }),
    );
    const expires_at = new Date("2027-01-31T00:00:00Z");
    const saved = await setSecret(admin, "gemini_api_key", VALUE, {
      expires_at,
    });
    expect(saved).toMatchObject({
      expires_at,
      check_status: "failing",
      check_message: "The key was refused.",
    });
    expect(JSON.stringify(saved)).not.toContain(VALUE);
  });

  it("refuses a curator both functions, and an unknown name", async () => {
    await expect(listSecrets(curator)).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(
      setSecret(curator, "openai_api_key", VALUE, { expires_at: null }),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(
      setSecret(admin, "not_a_secret", VALUE, { expires_at: null }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("keeps no 8 characters of a value a check echoes, in any answer, audit line or stored check", async () => {
    const ECHO = "sk-test-echoed-value-0042";
    const MODEL = "gpt-embed-large-7";
    const echo: Check = (_deps, value) =>
      Promise.resolve({
        status: "failing",
        message: `Refused: ${(typeof value === "string" ? value : ECHO).slice(2, 12)}.`,
      });
    registerCheck("powerbi_app_client_secret", echo);
    registerCheck("search.model", echo);
    const stored = { ...admin, settings: createSettingsStore(deps.db, {}) };
    await expect(
      setSetting(stored, "search.model", MODEL, { save_failing: false }),
    ).rejects.toThrow(/repeated part of the value/);
    const reading = new MemorySecrets([["powerbi_app_client_secret", ECHO]]);
    const answers = [
      await setSecret(admin, "powerbi_app_client_secret", ECHO, {
        expires_at: null,
      }),
      await setSetting(stored, "search.model", MODEL, { save_failing: true }),
      await runCheck(
        { ...admin, secrets: reading },
        "powerbi_app_client_secret",
      ),
      await runCheck(stored, "search.model"),
      await listSecrets(admin),
      await listSettings(stored),
      await adminStatus(stored),
      await exportBook(stored),
      await importBook(stored, "format: 1", { apply: false }),
      await deps.db.select().from(auditEvent),
    ];
    const text = JSON.stringify(answers);
    for (let at = 0; at + 8 <= ECHO.length; at++)
      expect(text).not.toContain(ECHO.slice(at, at + 8));
    const checks = JSON.stringify(await deps.db.select().from(settingCheck));
    for (let at = 0; at + 8 <= MODEL.length; at++)
      expect(checks).not.toContain(MODEL.slice(at, at + 8));
  });
});
