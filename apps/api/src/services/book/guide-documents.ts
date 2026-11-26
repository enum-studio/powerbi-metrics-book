import { metricVisibility } from "./visibility.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import {
  metric,
  metricEdge,
  metricLink,
  metricVariant,
} from "../../db/schema/book.js";
import { powerbiDataset, powerbiMeasure } from "../../db/schema/mirror.js";
import { personDeactivation, personProfile } from "../../db/schema/people.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { currentConventions } from "../conventions/store.js";
import { standsAlone } from "./drafter.js";
import { loadTree } from "./categories.js";
import { toDataset, toMeasure, variantVisibleTo } from "./metrics.js";

/** Read the guide in batches. The same visibility predicate gates its rows and every relation endpoint. */
export async function guideDocuments(context: ServiceContext) {
  const { db } = context;
  const visibility = await context.settings.get("access.metadata_visibility");
  const allowed = await context.access.describableDatasets(context.principal);
  const hides = !(await readsPii(context));
  const rows = await db
    .select()
    .from(metric)
    .where(and(visibleMetric(db, allowed, hides), isNull(metric.dismissed_at)));
  const ids = rows.map((row) => row.id);
  const byId = new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        label: row.label,
        importance: row.importance,
        tier: row.tier,
      },
    ]),
  );
  const links = await db
    .select()
    .from(metricLink)
    .where(
      and(
        inArray(metricLink.metric_id, ids),
        inArray(metricLink.other_metric_id, ids),
      ),
    );
  const edges = await db
    .select()
    .from(metricEdge)
    .where(inArray(metricEdge.parent_id, ids))
    .orderBy(asc(metricEdge.parent_id), asc(metricEdge.child_id));
  const owners = await db
    .select({
      id: user.id,
      name: user.name,
      title: personProfile.title,
      left: sql<boolean>`${personDeactivation.user_id} is not null`,
    })
    .from(user)
    .leftJoin(personProfile, eq(personProfile.person_id, user.id))
    .leftJoin(personDeactivation, eq(personDeactivation.user_id, user.id))
    .where(
      inArray(
        user.id,
        rows.flatMap((row) => (row.owner_person ? [row.owner_person] : [])),
      ),
    );
  const ownerById = new Map(
    owners.map((person) => [
      person.id,
      { ...person, title: person.title ?? "" },
    ]),
  );
  const variants = await db
    .selectDistinct({
      metric_id: metricVariant.metric_id,
      dataset: powerbiDataset.name,
      measure: powerbiMeasure.name,
      explanation: sql<
        string | null
      >`coalesce(${powerbiMeasure.description}, ${powerbiMeasure.description_pbi})`,
      is_base: sql<boolean>`${standsAlone}`,
    })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, toMeasure)
    .innerJoin(powerbiDataset, toDataset)
    .where(
      and(
        inArray(metricVariant.metric_id, ids),
        variantVisibleTo(metricVariant.metric_id, allowed, hides),
      ),
    );
  const datasets = new Map<string, string[]>();
  const formulas = new Map<string, string[]>();
  for (const variant of variants) {
    const names = datasets.get(variant.metric_id) ?? [];
    names.push(variant.dataset);
    datasets.set(variant.metric_id, names);
    if (variant.is_base && variant.explanation) {
      const entries = formulas.get(variant.metric_id) ?? [];
      entries.push(
        `${variant.dataset} / ${variant.measure}: ${variant.explanation}`,
      );
      formulas.set(variant.metric_id, entries);
    }
  }
  const tree = await loadTree(db);
  const categoryById = new Map(
    tree.rows.map((row) => [row.id, tree.anchor(row)]),
  );
  const rules = (await currentConventions(db)).metric_fields;
  const rank = (values: string[], value: string) => {
    const index = values.indexOf(value);
    return index < 0 ? values.length : index;
  };
  const linksById = new Map<string, typeof links>();
  for (const link of links)
    for (const id of [link.metric_id, link.other_metric_id]) {
      const list = linksById.get(id) ?? [];
      list.push(link);
      linksById.set(id, list);
    }
  const edgesById = new Map<string, typeof edges>();
  for (const edge of edges) {
    const list = edgesById.get(edge.parent_id) ?? [];
    list.push(edge);
    edgesById.set(edge.parent_id, list);
  }
  return rows.map((row) => {
    const children = edgesById.get(row.id) ?? [];
    const complete = children.every((edge) => byId.has(edge.child_id));
    const names = datasets.get(row.id) ?? [];
    return {
      ...row,
      kind: "metric" as const,
      formula: formulas.get(row.id)?.sort().join("\n\n") || null,
      category: row.category_id
        ? (categoryById.get(row.category_id) ?? null)
        : null,
      owner_person: row.owner_person
        ? (ownerById.get(row.owner_person) ?? null)
        : row.owner_person_name
          ? {
              id: null,
              name: row.owner_person_name,
              title: row.owner_person_title ?? "",
              left: true,
            }
          : null,
      who_may_see: metricVisibility(visibility, names),
      moves_with: (linksById.get(row.id) ?? [])
        .flatMap((link) => {
          const forward = row.id === link.metric_id;
          const other = byId.get(
            forward ? link.other_metric_id : link.metric_id,
          );
          return other
            ? [
                {
                  metric: other,
                  movement: link.movement,
                  reason: forward
                    ? link.reason || link.other_reason
                    : link.other_reason || link.reason,
                },
              ]
            : [];
        })
        .sort(
          (a, b) =>
            rank(rules.importance.values, a.metric.importance) -
              rank(rules.importance.values, b.metric.importance) ||
            rank(rules.tier.values, a.metric.tier) -
              rank(rules.tier.values, b.metric.tier) ||
            a.metric.name.localeCompare(b.metric.name),
        ),
      // A partial equation would change what the book says, so it is absent.
      edges: complete
        ? children.flatMap((edge) => {
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
  });
}
