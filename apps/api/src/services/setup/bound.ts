import pg from "pg";
import type { Db } from "../../context.js";
import { deploymentTenant } from "../../db/schema/tenant.js";
import { ServiceError } from "../../errors.js";

export type BoundTenant = { tenant_id: string; sample: boolean };

/** The tenant this database belongs to, or null before setup's first admin. */
export async function boundTenant(db: Db): Promise<BoundTenant | null> {
  const [row] = await db
    .select({
      tenant_id: deploymentTenant.tenant_id,
      sample: deploymentTenant.sample,
    })
    .from(deploymentTenant);
  return row ?? null;
}

/**
 * Records the tenant and the side of the mock the setup's sign-in came
 * through. One row, once: a second insert means setup already finished.
 */
export async function bindTenant(db: Db, bound: BoundTenant): Promise<void> {
  try {
    await db.insert(deploymentTenant).values(bound);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof pg.DatabaseError && cause.code === "23505")
      throw new ServiceError("invalid", "The setup already finished.");
    throw error;
  }
}
