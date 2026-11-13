import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db, ServiceContext } from "../../context.js";
import { category, metric } from "../../db/schema/book.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { withEvents } from "../events/feed.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { recordBookChange, requireCurator } from "./changes.js";

/*
 * Categories are addressed by their key path (sales/orders). The tree is a
 * few hundred rows at most, so every change reads all of it, checks its rules
 * in memory and writes under a lock: two curators changing the tree take
 * turns, and what one checked is still true when it commits. A category
 * change writes book_change and no event: the feed has no kind for it.
 */

const KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const LOCK_NAME = "powerbi_metrics_book.category";

type Row = typeof category.$inferSelect;
export type CategoryAnchor = {
  kind: "category";
  id: string;
  key: string;
  path: string;
  name: string;
  description: string | null;
  icon: string | null;
  position: number;
};
export type CategoryNode = CategoryAnchor & {
  /** Metrics in this category itself that the caller may see. */
  metric_count: number;
  children: CategoryNode[];
};

const bySiblingOrder = (a: Row, b: Row) =>
  a.position - b.position ||
  a.name.localeCompare(b.name) ||
  a.id.localeCompare(b.id);

export async function loadTree(db: Db) {
  const rows = await db.select().from(category);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, string>();
  const pathOf = (row: Row): string => {
    const known = paths.get(row.id);
    if (known !== undefined) return known;
    const parent = row.parent_id === null ? undefined : byId.get(row.parent_id);
    const path =
      parent === undefined ? row.key : `${pathOf(parent)}/${row.key}`;
    paths.set(row.id, path);
    return path;
  };
  const anchor = (row: Row): CategoryAnchor => ({
    kind: "category",
    id: row.id,
    key: row.key,
    path: pathOf(row),
    name: row.name,
    description: row.description,
    icon: row.icon,
    position: row.position,
  });
  return {
    rows,
    anchor,
    pathOf,
    get(path: string): Row {
      const row = rows.find((candidate) => pathOf(candidate) === path);
      if (row === undefined) {
        throw new ServiceError("not_found", `No such category: ${path}.`);
      }
      return row;
    },
    children: (parentId: string | null) =>
      rows.filter((row) => row.parent_id === parentId).sort(bySiblingOrder),
  };
}
export type Tree = Awaited<ReturnType<typeof loadTree>>;

/** The tree below `parent` (all of it without one), each category with the metrics in it the caller may see. */
export async function categoryTree(
  context: ServiceContext,
  parent?: string,
): Promise<CategoryNode[]> {
  const allowed = await context.access.describableDatasets(context.principal);
  const { db } = context;
  const tree = await loadTree(db);
  const counted = await db
    .select({ id: metric.category_id, metrics: count() })
    .from(metric)
    .where(
      and(
        isNotNull(metric.category_id),
        isNull(metric.dismissed_at),
        visibleMetric(db, allowed, !(await readsPii(context))),
      ),
    )
    .groupBy(metric.category_id);
  const counts = new Map(counted.map((row) => [row.id, row.metrics]));
  const below = (parentId: string | null): CategoryNode[] =>
    tree.children(parentId).map((row) => ({
      ...tree.anchor(row),
      metric_count: counts.get(row.id) ?? 0,
      children: below(row.id),
    }));
  return below(parent === undefined ? null : tree.get(parent).id);
}

type Session = { tx: Db; tree: Tree; principal: Principal };

async function edit<T>(
  context: ServiceContext,
  work: (session: Session) => Promise<T>,
): Promise<T> {
  await requireCurator(context);
  return withEvents(context.db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))`,
    );
    return work({
      tx,
      tree: await loadTree(tx),
      principal: context.principal,
    });
  });
}

const record = (
  { tx, principal }: Session,
  action: string,
  id: string,
  before: CategoryAnchor | null,
  after: CategoryAnchor | null,
) =>
  recordBookChange(tx, {
    principal,
    element_kind: "category",
    element_id: id,
    action,
    before,
    after,
  });

function checkKey(key: string): void {
  if (!KEY.test(key)) {
    throw new ServiceError(
      "invalid",
      `"${key}" is not a category key. Use snake_case, lowercase words joined by underscores, as in sales/orders.`,
    );
  }
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new ServiceError("invalid", "Give the category a name.");
  }
  return trimmed;
}

/** Where a new or moved category goes among its siblings: last. */
const lastPosition = (tree: Tree, parentId: string | null) =>
  Math.max(-1, ...tree.children(parentId).map((row) => row.position)) + 1;

/** Refuses a key that a sibling under `parentId` (other than `own`) already has. */
function refuseTakenKey(
  tree: Tree,
  parentId: string | null,
  key: string,
  own?: string,
): void {
  const clash = tree
    .children(parentId)
    .find((sibling) => sibling.key === key && sibling.id !== own);
  if (clash !== undefined) {
    throw new ServiceError(
      "conflict",
      `There is already a category ${tree.pathOf(clash)}.`,
    );
  }
}

export function createCategory(
  context: ServiceContext,
  path: string,
  input: { name: string; description?: string | null },
): Promise<CategoryAnchor> {
  return edit(context, async (session) => {
    const { tx, tree } = session;
    path.split("/").forEach(checkKey);
    const name = checkName(input.name);
    const cut = path.lastIndexOf("/");
    const parent = cut === -1 ? null : tree.get(path.slice(0, cut));
    const key = path.slice(cut + 1);
    refuseTakenKey(tree, parent?.id ?? null, key);
    const row = {
      id: randomUUID(),
      parent_id: parent?.id ?? null,
      key,
      name,
      description: input.description ?? null,
      position: lastPosition(tree, parent?.id ?? null),
    };
    await tx.insert(category).values(row);
    const next = await loadTree(tx);
    const after = next.anchor(next.get(path));
    await record(session, "create", row.id, null, after);
    return after;
  });
}

/**
 * Writes what differs, and records it; a change that changes nothing writes
 * nothing. `path` is where the category sits afterwards.
 */
async function change(
  session: Session,
  action: string,
  row: Row,
  changes: Partial<
    Pick<Row, "name" | "key" | "description" | "parent_id" | "position">
  >,
  path: string,
): Promise<CategoryAnchor> {
  const { tx, tree } = session;
  const before = tree.anchor(row);
  if (isDeepStrictEqual({ ...row, ...changes }, row)) return before;
  await tx.update(category).set(changes).where(eq(category.id, row.id));
  const next = await loadTree(tx);
  const after = next.anchor(next.get(path));
  await record(session, action, row.id, before, after);
  return after;
}

/** Changes the name, the key (and with it the path) or the description. */
export function renameCategory(
  context: ServiceContext,
  path: string,
  changes: { name?: string; key?: string; description?: string | null },
): Promise<CategoryAnchor> {
  return edit(context, (session) => {
    const row = session.tree.get(path);
    const { key } = changes;
    if (key !== undefined) {
      checkKey(key);
      refuseTakenKey(session.tree, row.parent_id, key, row.id);
    }
    return change(
      session,
      "update",
      row,
      {
        ...(changes.name !== undefined && { name: checkName(changes.name) }),
        ...(key !== undefined && { key }),
        ...(changes.description !== undefined && {
          description: changes.description,
        }),
      },
      path.slice(0, path.lastIndexOf("/") + 1) + (key ?? row.key),
    );
  });
}

/** Moves a category, with everything below it, under `parent` (null: to the top), last among its siblings unless `position` says. */
export function moveCategory(
  context: ServiceContext,
  path: string,
  to: { parent: string | null; position?: number },
): Promise<CategoryAnchor> {
  return edit(context, (session) => {
    const { tree } = session;
    const row = tree.get(path);
    const parent = to.parent === null ? null : tree.get(to.parent);
    if (to.parent === path || to.parent?.startsWith(`${path}/`)) {
      throw new ServiceError(
        "invalid",
        `The category ${path} cannot move into itself or below itself.`,
      );
    }
    const parentId = parent?.id ?? null;
    refuseTakenKey(tree, parentId, row.key, row.id);
    const position =
      to.position ??
      (parentId === row.parent_id
        ? row.position
        : lastPosition(tree, parentId));
    return change(
      session,
      "move",
      row,
      { parent_id: parentId, position },
      to.parent === null ? row.key : `${to.parent}/${row.key}`,
    );
  });
}

export function deleteCategory(
  context: ServiceContext,
  path: string,
): Promise<void> {
  return edit(context, async (session) => {
    const { tx, tree } = session;
    const row = tree.get(path);
    const children = tree.children(row.id).length;
    // Every metric counts, seen or not: a hidden one holds the category as well.
    const [held] = await tx
      .select({ metrics: count() })
      .from(metric)
      .where(eq(metric.category_id, row.id));
    const metrics = held?.metrics ?? 0;
    if (metrics + children > 0) {
      const holds = [
        metrics > 0 &&
          `${String(metrics)} ${metrics === 1 ? "metric" : "metrics"}`,
        children > 0 &&
          `${String(children)} ${children === 1 ? "child category" : "child categories"}`,
      ].filter((part) => part !== false);
      throw new ServiceError(
        "conflict",
        `The category ${path} holds ${holds.join(" and ")}. Move or delete them first, then delete the category.`,
      );
    }
    await tx.delete(category).where(eq(category.id, row.id));
    await record(session, "delete", row.id, tree.anchor(row), null);
  });
}
