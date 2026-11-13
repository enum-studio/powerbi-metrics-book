import { z } from "zod";
import type { AppDeps } from "../../context.js";
import { ServiceError } from "../../errors.js";

export async function lookupTenant(
  deps: AppDeps,
  email: string,
): Promise<{ tenant_id: string; domain: string }> {
  const at = email.lastIndexOf("@");
  const domain = email.slice(at + 1).toLowerCase();
  if (
    at < 1 ||
    domain.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  )
    throw new ServiceError(
      "invalid",
      "Enter a work email address, such as you@yourcompany.com.",
    );
  const authority = new URL(await deps.settings.get("powerbi.authority"))
    .origin;
  const response = await deps.fetcher.fetchFixed(
    `${authority}/${domain}/v2.0/.well-known/openid-configuration`,
    { timeout_ms: 5_000, max_bytes: 64 * 1024 },
  );
  if (response.status === 400)
    throw new ServiceError(
      "not_found",
      `Microsoft knows no tenant for ${domain}. Paste the tenant ID from the Overview page in Entra instead.`,
    );
  const upstream = () =>
    new ServiceError(
      "upstream",
      "Microsoft answered without a tenant ID. Paste the tenant ID from the Overview page in Entra instead.",
    );
  if (!response.ok) throw upstream();
  const answer = z.object({ issuer: z.url() }).safeParse(
    await response.json().catch(() => {
      throw upstream();
    }),
  );
  if (!answer.success) throw upstream();
  const tenant = new URL(answer.data.issuer).pathname
    .split("/")
    .find((part) => z.guid().safeParse(part).success);
  if (tenant === undefined) throw upstream();
  if (tenant.toLowerCase() === "9188040d-6c67-4c5b-b112-36a304b66dad")
    throw new ServiceError(
      "invalid",
      "That is a personal Microsoft account. Use your work email.",
    );
  return { tenant_id: tenant, domain };
}
