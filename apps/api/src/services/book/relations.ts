import { documentationError } from "./documentation-errors.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { metric, metricEdge, metricLink } from "../../db/schema/book.js";
import { ServiceError } from "../../errors.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import type { Conventions } from "../conventions/schema.js";
import { currentConventions } from "../conventions/store.js";
import { withEvents } from "../events/feed.js";
import { recordBookChange, requireCurator } from "./changes.js";
import {
  changeVisibility,
  lockMetric,
  openChange,
  resolveMetric,
  settle,
} from "./metrics.js";

export async function metricRelations(context: ServiceContext, id: string) {
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  id = (await resolveMetric(context.db, allowed, hides, id)).id;
  return relationsForMetric(
    context,
    id,
    allowed,
    hides,
    await currentConventions(context.db),
  );
}

/** The caller has already resolved this metric under the supplied visibility. */
export async function relationsForMetric(
  context: ServiceContext,
  id: string,
  allowed: SQL,
  hides: boolean,
  conventions: Conventions,
) {
  const result = await context.db.execute<{
    links: (typeof metricLink.$inferSelect)[];
    edges: (typeof metricEdge.$inferSelect)[];
    following: boolean;
  }>(sql`select
    ${context.principal.kind === "person" ? sql`exists(select from metric_follow where metric_id = ${id} and person_id = ${context.principal.id})` : sql`false`} as following,
    coalesce((select jsonb_agg(to_jsonb(l)) from metric_link l where l.metric_id = ${id} or l.other_metric_id = ${id}), '[]'::jsonb) as links,
    coalesce((select jsonb_agg(to_jsonb(e) order by e.child_id) from metric_edge e where e.parent_id = ${id}), '[]'::jsonb) as edges`);
  const { links, edges, following } = result.rows[0] ?? {
    links: [],
    edges: [],
    following: false,
  };
  if (!links.length && !edges.length)
    return { moves_with: [], edges: [], following };
  const neighbors = [
    ...new Set([
      ...links.flatMap((link) => [link.metric_id, link.other_metric_id]),
      ...edges.map((edge) => edge.child_id),
    ]),
  ];
  const visible = await context.db
    .select({
      id: metric.id,
      name: metric.name,
      label: metric.label,
      importance: metric.importance,
      tier: metric.tier,
    })
    .from(metric)
    .where(
      and(
        inArray(metric.id, neighbors),
        visibleMetric(context.db, allowed, hides),
        isNull(metric.dismissed_at),
      ),
    );
  const byId = new Map(visible.map((row) => [row.id, row]));
  const rules = conventions.metric_fields;
  const rank = (values: string[], value: string) => {
    const index = values.indexOf(value);
    return index < 0 ? values.length : index;
  };
  return {
    following,
    moves_with: links
      .flatMap((link) => {
        const forward = link.metric_id === id;
        const other = byId.get(forward ? link.other_metric_id : link.metric_id);
        if (!other) return [];
        return [
          {
            metric: other,
            movement: link.movement,
            reason: forward
              ? link.reason || link.other_reason
              : link.other_reason || link.reason,
          },
        ];
      })
      .sort(
        (a, b) =>
          rank(rules.importance.values, a.metric.importance) -
            rank(rules.importance.values, b.metric.importance) ||
          rank(rules.tier.values, a.metric.tier) -
            rank(rules.tier.values, b.metric.tier) ||
          a.metric.name.localeCompare(b.metric.name),
      ),
    edges: edges.every((edge) => byId.has(edge.child_id))
      ? edges.flatMap((edge) => {
          const child = byId.get(edge.child_id);
          return child
            ? [
                {
                  metric: child,
                  sign: edge.sign,
                  operation: edge.operation,
                  note: edge.note,
                },
              ]
            : [];
        })
      : [],
  };
}

type Link = {
  movement: "same" | "opposite" | "depends";
  reason: string;
  other_reason?: string;
};
type Edge = {
  sign: number;
  operation: "sum" | "product";
  note?: string | null;
};

export async function setRelation(
  context: ServiceContext,
  reference: string,
  other: string,
  input:
    { kind: "link"; value: Link | null } | { kind: "edge"; value: Edge | null },
) {
  await requireCurator(context);
  const visibility = await changeVisibility(context);
  await withEvents(context.db, async (tx, emit) => {
    // Every graph mutation takes the same lock, before any metric row lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('metric_relations'))`,
    );
    const change = await openChange(context, tx, emit, visibility);
    const first = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      reference,
    );
    const second = await resolveMetric(
      tx,
      change.allowed,
      change.hidesPii,
      other,
    );
    if (first.id === second.id)
      throw new ServiceError("invalid", "Link two different metrics.");
    const low = await lockMetric(
      tx,
      first.id < second.id ? first.id : second.id,
    );
    const high = await lockMetric(
      tx,
      first.id < second.id ? second.id : first.id,
    );
    const beforeFirst = low.id === first.id ? low : high;
    const beforeSecond = low.id === second.id ? low : high;
    let before: unknown;
    let after: unknown;
    if (input.kind === "edge") {
      const key = { parent_id: first.id, child_id: second.id };
      const where = and(
        eq(metricEdge.parent_id, first.id),
        eq(metricEdge.child_id, second.id),
      );
      [before] = await tx.select().from(metricEdge).where(where);
      if (input.value === null) await tx.delete(metricEdge).where(where);
      else {
        const cycle = await tx.execute<{
          cycle: boolean;
        }>(sql`with recursive descendants(id) as (
          select child_id from metric_edge where parent_id = ${second.id}
          union select e.child_id from metric_edge e join descendants d on e.parent_id = d.id
        ) select exists(select from descendants where id = ${first.id}) as cycle`);
        if (cycle.rows[0]?.cycle)
          throw new ServiceError(
            "invalid",
            "This edge would make a cycle. Choose a child that does not lead back to the parent.",
          );
        [after] = await tx
          .insert(metricEdge)
          .values({ ...key, ...input.value })
          .onConflictDoUpdate({
            target: [metricEdge.parent_id, metricEdge.child_id],
            set: input.value,
          })
          .returning();
      }
    } else {
      const forward = first.id < second.id;
      const key = {
        metric_id: forward ? first.id : second.id,
        other_metric_id: forward ? second.id : first.id,
      };
      const where = and(
        eq(metricLink.metric_id, key.metric_id),
        eq(metricLink.other_metric_id, key.other_metric_id),
      );
      [before] = await tx.select().from(metricLink).where(where);
      if (input.value === null) await tx.delete(metricLink).where(where);
      else {
        const value = {
          movement: input.value.movement,
          reason: forward
            ? input.value.reason
            : (input.value.other_reason ?? ""),
          other_reason: forward
            ? (input.value.other_reason ?? "")
            : input.value.reason,
        };
        if (!(value.reason.trim() || value.other_reason.trim()))
          throw new ServiceError(
            "invalid",
            "Explain why these metrics move together.",
          );
        [after] = await tx
          .insert(metricLink)
          .values({ ...key, ...value })
          .onConflictDoUpdate({
            target: [metricLink.metric_id, metricLink.other_metric_id],
            set: value,
          })
          .returning();
      }
    }
    if (isDeepStrictEqual(before, after)) return;
    await recordBookChange(tx, {
      principal: context.principal,
      element_kind: `metric_${input.kind}`,
      element_id: first.id,
      action: input.value ? "set" : "delete",
      before,
      after,
    });
    await settle(change, beforeFirst, "relationship", {}, true);
    await settle(change, beforeSecond, "relationship", {}, true);
  }).catch(documentationError);
  return metricRelations(context, reference);
}
