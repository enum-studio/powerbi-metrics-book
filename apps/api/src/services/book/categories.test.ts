import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appReader,
  asPerson,
  fileUnder,
  id,
  metricIn,
  outsider,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { bookChange, category, metric } from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import type { Principal } from "../../principal.js";
import {
  categoryTree,
  createCategory,
  deleteCategory,
  moveCategory,
  renameCategory,
} from "./categories.js";

useMirror();

// Root keys are unique in the shared database, and files run side by side, so
// the keys and metric names here carry a suffix of this run's own.
const suffix = randomUUID().slice(0, 8);
const top = `sales_${suffix}`;
const baskets = `baskets_${suffix}`;
const twin = `returns_${suffix}`;
const absent = `absent_${suffix}`;
const curator = reaching({}, "curator");
const as = (tx: Db, principal: Principal = curator) =>
  asPerson(principal, { db: tx });

/** The category events and changes about the categories a test made; others' commits are not its business. */
const eventsAbout = async (tx: Db, ids: string[]) =>
  (
    await tx
      .select({ n: count() })
      .from(event)
      .where(
        and(eq(event.element_kind, "category"), inArray(event.element_id, ids)),
      )
  )[0]?.n;
const changesAbout = (tx: Db, ids: string[]) =>
  tx
    .select()
    .from(bookChange)
    .where(
      and(
        eq(bookChange.element_kind, "category"),
        inArray(bookChange.element_id, ids),
      ),
    )
    .orderBy(asc(bookChange.id));

describe("deleteCategory", () => {
  it("is refused while the category holds metrics, naming how many", () =>
    rolledBack(async (tx) => {
      const held = await createCategory(as(tx), top, { name: "Sales" });
      await metricIn(tx, "number_of_a_cat_test", held.id);
      await metricIn(tx, "number_of_b_cat_test", held.id);
      const deleting = deleteCategory(as(tx), top);
      await expect(deleting).rejects.toMatchObject({ kind: "conflict" });
      await expect(deleting).rejects.toThrow(`${top} holds 2 metrics`);
    }));

  it("is refused while the category has children, and counts metrics the caller cannot see", () =>
    rolledBack(async (tx) => {
      const sales = await createCategory(as(tx), top, { name: "Sales" });
      await createCategory(as(tx), `${top}/orders`, { name: "Orders" });
      await expect(deleteCategory(as(tx), top)).rejects.toThrow(
        `${top} holds 1 child category`,
      );
      await deleteCategory(as(tx), `${top}/orders`);
      const hidden = await metricIn(tx, "total_hidden_cat_test", sales.id);
      await fileUnder(tx, hidden, id.profit);
      await expect(deleteCategory(as(tx), top)).rejects.toThrow(
        `${top} holds 1 metric.`,
      );
      await tx.delete(metric).where(eq(metric.id, hidden));
      await deleteCategory(as(tx), top);
      expect(
        await tx.select().from(category).where(eq(category.key, top)),
      ).toEqual([]);
    }));
});

describe("changing the tree", () => {
  it("creates, renames, moves and deletes, recording each in book_change and announcing none", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const sales = await createCategory(context, top, {
        name: "Sales",
        description: "Everything sold.",
      });
      const orders = await createCategory(context, `${top}/orders`, {
        name: "Orders",
      });
      const returns = await createCategory(context, `${top}/returns`, {
        name: "Returns",
      });
      expect(orders).toMatchObject({ path: `${top}/orders`, position: 0 });

      const renamed = await renameCategory(context, `${top}/orders`, {
        key: baskets,
        name: "Baskets",
      });
      expect(renamed).toMatchObject({
        id: orders.id,
        path: `${top}/${baskets}`,
      });
      const moved = await moveCategory(context, `${top}/${baskets}`, {
        parent: null,
      });
      expect(moved).toMatchObject({ path: baskets });
      await moveCategory(context, baskets, { parent: top, position: 5 });
      await deleteCategory(context, `${top}/returns`);

      const tree = await categoryTree(context);
      expect(tree.filter((node) => node.id === sales.id)).toMatchObject([
        {
          description: "Everything sold.",
          children: [{ path: `${top}/${baskets}`, position: 5 }],
        },
      ]);
      const ids = [sales.id, orders.id, returns.id];
      const changes = await changesAbout(tx, ids);
      expect(
        changes.map((row) => [row.action, row.principal_id, row.via]),
      ).toEqual(
        ["create", "create", "create", "update", "move", "move", "delete"].map(
          (action) => [action, "test-curator", "browser"],
        ),
      );
      expect(changes[3]).toMatchObject({
        element_id: orders.id,
        before: { path: `${top}/orders`, name: "Orders" },
        after: { path: `${top}/${baskets}`, name: "Baskets" },
      });
      expect(changes[0]?.before).toBeNull();
      expect(changes[6]?.after).toBeNull();
      expect(await eventsAbout(tx, ids)).toBe(0);
    }));

  it("writes nothing for a change that changes nothing", () =>
    rolledBack(async (tx) => {
      const sales = await createCategory(as(tx), top, { name: "Sales" });
      await renameCategory(as(tx), top, { name: "Sales" });
      await moveCategory(as(tx), top, { parent: null });
      const changes = await changesAbout(tx, [sales.id]);
      expect(changes.map((row) => row.action)).toEqual(["create"]);
    }));

  it("refuses a viewer every change", () =>
    rolledBack(async (tx) => {
      const sales = await createCategory(as(tx), top, { name: "Sales" });
      const viewer = as(tx, reaching({}));
      const attempts = [
        () => createCategory(viewer, `${top}/orders`, { name: "Orders" }),
        () => renameCategory(viewer, top, { name: "Shop" }),
        () => moveCategory(viewer, top, { parent: null }),
        () => deleteCategory(viewer, top),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({
          kind: "refused",
          message: "You may not curate this book.",
        });
      }
      expect(
        await tx
          .select({ id: category.id })
          .from(category)
          .where(eq(category.parent_id, sales.id)),
      ).toEqual([]);
      expect(await changesAbout(tx, [sales.id])).toHaveLength(1);
    }));

  it("refuses what would break the tree, with a sentence that says why", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      await createCategory(context, top, { name: "Sales" });
      await createCategory(context, `${top}/orders`, { name: "Orders" });
      await createCategory(context, twin, { name: "Returns" });
      await createCategory(context, `${top}/${twin}`, { name: "Returns" });
      const refusals: [() => Promise<unknown>, string, string][] = [
        [
          () => createCategory(context, `${top}/Orders`, { name: "Orders" }),
          "invalid",
          `"Orders" is not a category key. Use snake_case, lowercase words joined by underscores, as in sales/orders.`,
        ],
        [
          () => createCategory(context, `${top}/orders`, { name: "Orders" }),
          "conflict",
          `There is already a category ${top}/orders.`,
        ],
        [
          () => createCategory(context, `${absent}/orders`, { name: "Orders" }),
          "not_found",
          `No such category: ${absent}.`,
        ],
        [
          () => createCategory(context, `${top}/more`, { name: " " }),
          "invalid",
          "Give the category a name.",
        ],
        [
          () => moveCategory(context, top, { parent: `${top}/orders` }),
          "invalid",
          `The category ${top} cannot move into itself or below itself.`,
        ],
        [
          () => moveCategory(context, twin, { parent: top }),
          "conflict",
          `There is already a category ${top}/${twin}.`,
        ],
        [
          () => renameCategory(context, `${top}/orders`, { key: twin }),
          "conflict",
          `There is already a category ${top}/${twin}.`,
        ],
        [
          () => deleteCategory(context, absent),
          "not_found",
          `No such category: ${absent}.`,
        ],
      ];
      for (const [attempt, kind, message] of refusals) {
        await expect(attempt()).rejects.toMatchObject({ kind, message });
      }
    }));
});

describe("categoryTree", () => {
  it("counts the metrics the caller may see, and shows the subtree under a parent", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const sales = await createCategory(context, top, { name: "Sales" });
      const orders = await createCategory(context, `${top}/orders`, {
        name: "Orders",
      });
      await createCategory(context, `${top}/orders/web`, { name: "Web" });
      await fileUnder(
        tx,
        await metricIn(tx, "total_seen_cat_test", orders.id),
        id.net_sales,
      );
      await fileUnder(
        tx,
        await metricIn(tx, "total_shown_cat_test", sales.id),
        id.net_sales_ly,
      );
      // Filed only on Finance's dataset, which the app reader may not describe.
      await fileUnder(
        tx,
        await metricIn(tx, "total_finance_cat_test", orders.id),
        id.profit,
      );
      // No variants yet, so everyone sees it.
      await metricIn(tx, "total_bare_cat_test", orders.id);

      const counts = async (principal: Principal) => {
        const nodes = await categoryTree(as(tx, principal));
        const root = nodes.find((node) => node.id === sales.id);
        const [child] = root?.children ?? [];
        return [root?.metric_count, child?.metric_count];
      };
      expect(await counts(appReader)).toEqual([1, 2]);
      expect(await counts(outsider)).toEqual([0, 1]);

      // A dismissed metric is no longer in the lists, so no longer in the count.
      await tx
        .update(metric)
        .set({ dismissed_at: new Date() })
        .where(eq(metric.name, "total_bare_cat_test"));
      expect(await counts(outsider)).toEqual([0, 0]);
      await tx
        .update(metric)
        .set({ dismissed_at: null })
        .where(eq(metric.name, "total_bare_cat_test"));

      const below = await categoryTree(as(tx, appReader), `${top}/orders`);
      expect(below).toMatchObject([
        { path: `${top}/orders/web`, metric_count: 0, children: [] },
      ]);
      await expect(
        categoryTree(as(tx, appReader), absent),
      ).rejects.toMatchObject({ kind: "not_found" });
    }));
});
