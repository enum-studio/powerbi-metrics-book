import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { auditEvent } from "../../db/schema/audit.js";
import { brandLogo } from "../../db/schema/branding.js";
import { JPEG, PNG, WEBP } from "../../../test/images.js";
import { brandOf, deleteLogo, putLogo, readLogo } from "./branding.js";
afterAll(closeTestPools);
const settings = new MemorySettings();
const deps = createTestDeps({ settings, access: cerbosAccess(settings) });
const admin = { ...deps, principal: principals.admin };
beforeEach(async () => {
  await deps.db.delete(brandLogo);
});
it("stores and replaces every supported signature, hashes bytes and audits changes", async () => {
  for (const [bytes, content_type] of [
    [PNG, "image/png"],
    [JPEG, "image/jpeg"],
    [WEBP, "image/webp"],
  ] as const) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await putLogo(admin, bytes);
    const logo = await readLogo({ db: deps.db });
    expect(logo).toEqual({ bytes, content_type, sha256 });
    expect(await deps.db.select().from(brandLogo)).toHaveLength(1);
    const events = await deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "admin.branding.update"));
    expect(events.at(-1)).toMatchObject({
      principal_id: principals.admin.id,
      detail: { logo: sha256 },
    });
  }
  await deleteLogo(admin);
  expect(await readLogo(deps)).toBeNull();
  const events = await deps.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.action, "admin.branding.update"));
  expect(events.at(-1)?.detail).toEqual({ logo: null });
});
it("answers default and custom branding with a digest URL and accepts exactly 256 KB", async () => {
  expect(await brandOf(deps)).toEqual({
    name: "Power BI Metrics Book",
    company: null,
    logo_url: null,
    custom: false,
  });
  await settings.set("branding.name", "Sample brand");
  await settings.set("branding.company", "Sample company");
  const bytes = new Uint8Array(262144);
  bytes.set(JPEG.subarray(0, -2));
  bytes.set([0xff, 0xd9], bytes.length - 2);
  await putLogo(admin, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(await brandOf(deps)).toEqual({
    name: "Sample brand",
    company: "Sample company",
    logo_url: `https://metrics.example.com/api/branding/logo?v=${digest.slice(0, 12)}`,
    custom: true,
  });
});
