import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AppDeps, ServiceContext } from "../../context.js";
import { brandLogo } from "../../db/schema/branding.js";
import { ServiceError } from "../../errors.js";
import { signInConfigChanged } from "../auth/sign-in-config.js";
import { audited, requireAdmin } from "./guard.js";
export async function putLogo(
  context: ServiceContext,
  bytes: Uint8Array,
): Promise<void> {
  await requireAdmin(context, "manage_settings");
  if (bytes.length > 262144)
    throw new ServiceError("invalid", "The logo is larger than 256 KB.");
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pngEnds = () => {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const end = offset + length + 12;
      if (end > bytes.length) return false;
      if (starts([73, 69, 78, 68], offset + 4))
        return length === 0 && end === bytes.length;
      offset = end;
    }
    return false;
  };
  const content_type =
    starts([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) && pngEnds()
      ? "image/png"
      : starts([0xff, 0xd8, 0xff]) && starts([0xff, 0xd9], bytes.length - 2)
        ? "image/jpeg"
        : starts([82, 73, 70, 70]) &&
            starts([87, 69, 66, 80], 8) &&
            view.getUint32(4, true) === bytes.length - 8
          ? "image/webp"
          : null;
  if (content_type === null)
    throw new ServiceError(
      "invalid",
      "The logo must be a PNG, JPEG or WebP image.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const values = { content_type, bytes, sha256 } as const;
  await context.db
    .insert(brandLogo)
    .values(values)
    .onConflictDoUpdate({
      target: brandLogo.id,
      set: { ...values, updated_at: context.clock() },
    });
  signInConfigChanged(context.db);
  await audited(
    context,
    "branding.update",
    { kind: "brand_logo", id: "logo" },
    {
      logo: sha256,
    },
  );
}
export async function deleteLogo(context: ServiceContext): Promise<void> {
  await requireAdmin(context, "manage_settings");
  await context.db.delete(brandLogo);
  signInConfigChanged(context.db);
  await audited(
    context,
    "branding.update",
    { kind: "brand_logo", id: "logo" },
    {
      logo: null,
    },
  );
}
export async function readLogo(
  deps: Pick<AppDeps, "db">,
  sha256?: string,
): Promise<{ content_type: string; bytes: Uint8Array; sha256: string } | null> {
  const [logo] = await deps.db
    .select({
      content_type: brandLogo.content_type,
      bytes: brandLogo.bytes,
      sha256: brandLogo.sha256,
    })
    .from(brandLogo)
    .where(sha256 === undefined ? undefined : eq(brandLogo.sha256, sha256));
  return logo ?? null;
}
export async function readLogoMetadata(deps: Pick<AppDeps, "db">) {
  const [logo] = await deps.db
    .select({ content_type: brandLogo.content_type, sha256: brandLogo.sha256 })
    .from(brandLogo);
  return logo ?? null;
}
export async function brandOf(
  deps: Pick<AppDeps, "db" | "settings" | "config">,
) {
  const name = await deps.settings.get("branding.name");
  const company = await deps.settings.get("branding.company");
  const [logo] = await deps.db
    .select({ sha256: brandLogo.sha256 })
    .from(brandLogo);
  return {
    name: name ?? "Power BI Metrics Book",
    company,
    logo_url:
      logo === undefined
        ? null
        : `${deps.config.public_base_url.toString().replace(/\/$/, "")}/api/branding/logo?v=${logo.sha256.slice(0, 12)}`,
    custom: name !== null,
  };
}
