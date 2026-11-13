import { signInConfigReader } from "../auth/sign-in-config.js";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { settingCheck } from "../../db/schema/admin.js";
import { auditEvent } from "../../db/schema/audit.js";
import { handlerFor } from "../jobs/registry.js";
import { createSettingsStore } from "../settings/store.js";
import { registerCheck, runCheck, screened, storeCheck } from "./checks.js";
import { listSettings, setSetting, storedChecks } from "./settings.js";

afterAll(closeTestPools);

const base = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const deps = { ...base, settings: createSettingsStore(base.db, {}) };
const admin = { ...deps, principal: principals.admin };
const curator = { ...deps, principal: principals.curator };

// search.model passes only for a model named text-embedding-*.
const checked: unknown[] = [];
registerCheck("search.model", (_deps, value) => {
  checked.push(value);
  return Promise.resolve(
    typeof value === "string" && value.startsWith("text-embedding-")
      ? { status: "passing", message: null }
      : { status: "failing", message: "The provider has no such model." },
  );
});
let stepPasses = true;
registerCheck("test_step", () =>
  Promise.resolve(
    stepPasses
      ? { status: "passing", message: null }
      : { status: "failing", message: "The step failed." },
  ),
);

describe("settings in the admin section", () => {
  it("lists every key with its value, source and description", async () => {
    const listed = await listSettings(admin);
    expect(listed.find((s) => s.key === "results.ttl_hours")).toMatchObject({
      value: 24,
      source: "default",
      description: expect.any(String) as unknown,
      check: null,
    });
  });

  it("saves a valid value, auditing the key", async () => {
    const saved = await setSetting(admin, "results.ttl_hours", 48, {
      save_failing: false,
    });
    expect(saved).toMatchObject({ value: 48, source: "database" });
    const audits = await deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "admin.setting.set"));
    expect(audits.map((a) => a.resource_id)).toContain("results.ttl_hours");
  });

  it("refuses a value its schema refuses, and a key that does not exist", async () => {
    await expect(
      setSetting(admin, "results.ttl_hours", -1, { save_failing: true }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      setSetting(admin, "no.such_key", 1, { save_failing: true }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("takes none, viewer or curator as the default role, never admin or pii_reader", async () => {
    await setSetting(admin, "access.default_role", "curator", {
      save_failing: false,
    });
    for (const role of ["admin", "pii_reader", "analyst"])
      await expect(
        setSetting(admin, "access.default_role", role, { save_failing: true }),
      ).rejects.toMatchObject({ kind: "invalid" });
    expect(await deps.settings.get("access.default_role")).toBe("curator");
  });

  it("refuses a value that fails its check unless save_failing, and marks it failing until one passes", async () => {
    await expect(
      setSetting(admin, "search.model", "nope", { save_failing: false }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(await deps.settings.source("search.model")).toBe("default");
    const kept = await setSetting(admin, "search.model", "nope", {
      save_failing: true,
    });
    expect(kept).toMatchObject({
      value: "nope",
      check: { status: "failing", message: "The provider has no such model." },
    });
    const passed = await setSetting(
      admin,
      "search.model",
      "text-embedding-3-small",
      { save_failing: false },
    );
    expect(passed.check?.status).toBe("passing");
    expect(checked).toEqual(["nope", "nope", "text-embedding-3-small"]);
  });

  it("runs a step's check by name, and every check in the daily job", async () => {
    stepPasses = false;
    expect(await runCheck(admin, "test_step")).toEqual({
      status: "failing",
      message: "The step failed.",
    });
    stepPasses = true;
    const job = handlerFor("check", "api");
    expect(job?.runner).toBe("api");
    await job?.handler(deps, {}, "schedule");
    const rows = await deps.db.select().from(settingCheck);
    expect(
      rows
        .map(({ key, status }) => ({ key, status }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([
      { key: "search.model", status: "passing" },
      { key: "test_step", status: "passing" },
    ]);
    await expect(runCheck(admin, "no_such_check")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("refuses a curator every function", async () => {
    await expect(listSettings(curator)).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(
      setSetting(curator, "results.ttl_hours", 24, { save_failing: false }),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(runCheck(curator, "test_step")).rejects.toMatchObject({
      kind: "refused",
    });
  });
});

it("keeps check details and normalizes absent details, including a replacement", async () => {
  const details = { workspaces: [], truncated: false };
  await storeCheck(deps, "test_step", {
    status: "passing",
    message: null,
    details,
  });
  expect((await storedChecks(deps.db)).get("test_step")?.details).toEqual(
    details,
  );
  await storeCheck(deps, "test_step", { status: "passing", message: null });
  expect(
    (await storedChecks(deps.db)).get("test_step")?.details,
  ).toBeUndefined();
  const [stored] = await deps.db
    .select()
    .from(settingCheck)
    .where(eq(settingCheck.key, "test_step"));
  expect(stored?.details).toBeNull();
});

it("keeps a result's shape when screening and storing it", async () => {
  const result = {
    status: "passing" as const,
    message: "Sample check",
    details: { workspaces: [], truncated: false },
    action: "connect" as const,
  };
  const screenedResult = screened("test_step", result, "Sample check");
  expect(screenedResult.message).not.toBe(result.message);
  expect(screenedResult.details.workspaces).toEqual([]);
  const stored = await storeCheck(deps, "test_step", screenedResult);
  expect(stored.action).toBe("connect");
  expect(stored.details.truncated).toBe(false);
});

it("refreshes cached sign-in branding and default access after settings commit", async () => {
  await setSetting(admin, "access.default_role", "viewer", {
    save_failing: false,
  });
  const read = signInConfigReader(deps);
  expect(await read()).toMatchObject({ invite_only: false });
  for (const [key, value] of [
    ["branding.name", "Sample company"],
    ["branding.company", "Sample"],
    ["access.default_role", "none"],
  ] as const) {
    await setSetting(admin, key, value, { save_failing: false });
    const config = await read();
    expect(config).toMatchObject(
      key === "access.default_role"
        ? { invite_only: true }
        : { brand: { [key === "branding.name" ? "name" : "company"]: value } },
    );
  }
});
