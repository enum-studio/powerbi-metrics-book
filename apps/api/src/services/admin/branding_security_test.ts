import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { brandLogo } from "../../db/schema/branding.js";
import { JPEG, PNG, WEBP } from "../../../test/images.js";
import { deleteLogo, putLogo } from "./branding.js";
afterAll(closeTestPools);
const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const admin = { ...deps, principal: principals.admin };
it("refuses SVG and stores nothing", async () => {
  await expect(
    putLogo(
      admin,
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ),
  ).rejects.toMatchObject({
    kind: "invalid",
    message: "The logo must be a PNG, JPEG or WebP image.",
  });
  expect(await deps.db.select().from(brandLogo)).toEqual([]);
});
it("refuses HTML, GIF, truncated and misplaced signatures and oversized PNG", async () => {
  const oversized = new Uint8Array(262145);
  oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const bytes of [
    new TextEncoder().encode("<html>logo</html>"),
    new TextEncoder().encode("GIF89a"),
    new Uint8Array(),
    new Uint8Array([255, 216]),
    new TextEncoder().encode("xRIFF0000WEBP"),
    oversized,
  ]) {
    await expect(putLogo(admin, bytes)).rejects.toMatchObject({
      kind: "invalid",
      message:
        bytes === oversized
          ? "The logo is larger than 256 KB."
          : "The logo must be a PNG, JPEG or WebP image.",
    });
    expect(await deps.db.select().from(brandLogo)).toEqual([]);
  }
});
it("refuses writes and deletes by non-admins and service accounts with every role", async () => {
  const bytes = JPEG;
  await putLogo(admin, bytes);
  for (const principal of [
    principals.viewer,
    principals.curator,
    {
      ...principals.admin,
      kind: "service_account" as const,
      roles: ["viewer", "curator", "admin", "pii_reader", "integration"],
    },
  ]) {
    const context = { ...deps, principal };
    await expect(putLogo(context, bytes)).rejects.toMatchObject({
      kind: "refused",
    });
    await expect(deleteLogo(context)).rejects.toMatchObject({
      kind: "refused",
    });
    expect((await deps.db.select().from(brandLogo))[0]?.bytes).toEqual(bytes);
  }
});

it("checks image structure and accepts small PNG, JPEG and WebP images", async () => {
  const png = Buffer.from(PNG);
  const jpeg = Buffer.from(JPEG);
  const webp = Buffer.from(WEBP);
  await deleteLogo(admin);
  for (const bytes of [
    Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("<script>alert(1)</script>"),
    ]),
    Buffer.concat([png, Buffer.from("script")]),
    png.subarray(0, png.length - 1),
    jpeg.subarray(0, jpeg.length - 1),
    webp.subarray(0, webp.length - 1),
  ]) {
    await expect(putLogo(admin, bytes)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(await deps.db.select().from(brandLogo)).toEqual([]);
  }
  for (const bytes of [png, jpeg, webp]) {
    await putLogo(admin, bytes);
    expect((await deps.db.select().from(brandLogo))[0]?.bytes).toEqual(
      new Uint8Array(bytes),
    );
  }
  await deleteLogo(admin);
});
