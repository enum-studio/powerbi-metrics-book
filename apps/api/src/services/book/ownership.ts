import { and, eq, isNull, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { metric, metricFollow } from "../../db/schema/book.js";
import { personDeactivation, personProfile } from "../../db/schema/people.js";
import { ServiceError } from "../../errors.js";
import { withAdminLock } from "../admin/people.js";
import { requireAdmin } from "../admin/guard.js";
import { readsPii } from "../pii/rules.js";
import {
  amendMetric,
  getMetric,
  resolveMetric,
  type MetricRow,
} from "./metrics.js";

export function requirePerson(context: ServiceContext): string {
  if (context.principal.kind !== "person")
    throw new ServiceError(
      "refused",
      "Only a signed-in person has personal metrics.",
    );
  return context.principal.id;
}

export async function ownerOf(context: ServiceContext, row: MetricRow) {
  if (row.owner_person === null)
    return row.owner_person_name === null
      ? null
      : {
          id: null,
          name: row.owner_person_name,
          title: row.owner_person_title ?? "",
          left: true,
        };
  const [person] = await context.db
    .select({
      id: user.id,
      name: user.name,
      title: personProfile.title,
      left: sql<boolean>`${personDeactivation.user_id} is not null`,
    })
    .from(user)
    .leftJoin(personProfile, eq(personProfile.person_id, user.id))
    .leftJoin(personDeactivation, eq(personDeactivation.user_id, user.id))
    .where(eq(user.id, row.owner_person));
  return person ? { ...person, title: person.title ?? "" } : null;
}

export async function setOwner(
  context: ServiceContext,
  reference: string,
  email: string | null,
) {
  const id = await amendMetric(
    context,
    reference,
    "owner",
    async ({ tx }, before) => {
      let owner: { id: string; name: string; title: string | null } | undefined;
      if (email !== null) {
        [owner] = await tx
          .select({ id: user.id, name: user.name, title: personProfile.title })
          .from(user)
          .leftJoin(personProfile, eq(personProfile.person_id, user.id))
          .leftJoin(personDeactivation, eq(personDeactivation.user_id, user.id))
          .where(
            and(
              sql`lower(${user.email}) = lower(${email})`,
              isNull(personDeactivation.user_id),
            ),
          );
        if (!owner)
          throw new ServiceError(
            "invalid",
            "Choose an active person in this deployment by their email.",
          );
      }
      await tx
        .update(metric)
        .set({
          owner_person: owner?.id ?? null,
          owner_person_name: owner?.name ?? null,
          owner_person_title: owner?.title ?? null,
        })
        .where(eq(metric.id, before.id));
    },
  );
  return getMetric(context, id);
}

export async function following(
  context: ServiceContext,
  metricId: string,
): Promise<boolean> {
  if (context.principal.kind !== "person") return false;
  const [row] = await context.db
    .select()
    .from(metricFollow)
    .where(
      and(
        eq(metricFollow.person_id, context.principal.id),
        eq(metricFollow.metric_id, metricId),
      ),
    );
  return row !== undefined;
}

export async function followMetric(
  context: ServiceContext,
  reference: string,
  follow: boolean,
) {
  const person_id = requirePerson(context);
  const allowed = await context.access.describableDatasets(context.principal);
  const found = await resolveMetric(
    context.db,
    allowed,
    !(await readsPii(context)),
    reference,
  );
  if (follow)
    await context.db
      .insert(metricFollow)
      .values({ person_id, metric_id: found.id })
      .onConflictDoNothing();
  else
    await context.db
      .delete(metricFollow)
      .where(
        and(
          eq(metricFollow.person_id, person_id),
          eq(metricFollow.metric_id, found.id),
        ),
      );
  return { following: follow };
}

export async function setTitle(
  context: ServiceContext,
  personId: string,
  title: string,
) {
  const own = requirePerson(context);
  if (own !== personId) await requireAdmin(context, "manage_people");
  return withAdminLock(context, async (tx) => {
    const [found] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, personId));
    if (!found) throw new ServiceError("not_found", "No such person.");
    await tx
      .insert(personProfile)
      .values({ person_id: personId, title })
      .onConflictDoUpdate({ target: personProfile.person_id, set: { title } });
    return { id: personId, title };
  });
}
