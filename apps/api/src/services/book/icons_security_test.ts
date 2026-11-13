import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appReader,
  asPerson,
  fileUnder,
  id,
  metricIn,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { bookChange, category, metric, term } from "../../db/schema/book.js";
import type { Principal } from "../../principal.js";
import { ICON_KINDS, setIcon, type IconKind } from "./icons.js";

useMirror();

/*
 * An icon is written by a curator and read by everyone. A viewer is refused on
 * every kind; an element the caller cannot see answers like a missing one; a
 * write from a token cannot undo a person's approval; and every write leaves
 * its book_change row.
 */

const ICON = "glyph:store:blue";
const curator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const as = (tx: Db, principal: Principal = curator) =>
  asPerson(principal, { db: tx });

async function oneOfEach(tx: Db): Promise<Record<IconKind, string>> {
  const metricId = await metricIn(tx, "icon_security_metric");
  await fileUnder(tx, metricId, id.net_sales);
  const [cat] = await tx
    .insert(category)
    .values({ name: "Security", key: "security" })
    .returning({ id: category.id });
  const [word] = await tx
    .insert(term)
    .values({ name: "Icon security" })
    .returning({ id: term.id });
  return {
    metric: metricId,
    category: cat?.id ?? "",
    term: word?.id ?? "",
    workspace: id.sales_workspace,
    dataset: id.sales,
  };
}

describe("an icon is a curator's to set", () => {
  it("refuses a viewer on each kind, and changes nothing", () =>
    rolledBack(async (tx) => {
      const ids = await oneOfEach(tx);
      for (const kind of ICON_KINDS) {
        await expect(
          setIcon(as(tx, appReader), { kind, id: ids[kind] }, ICON),
        ).rejects.toMatchObject({ kind: "refused" });
        await expect(
          setIcon(as(tx, appReader), { kind, id: ids[kind] }, null),
        ).rejects.toMatchObject({ kind: "refused" });
      }
      expect(
        await tx.select().from(bookChange).where(eq(bookChange.action, "icon")),
      ).toEqual([]);
    }));

  it("answers a curator who cannot see a dataset or its workspace like a missing one", () =>
    rolledBack(async (tx) => {
      const blind = reaching({}, "curator");
      const answer = (kind: IconKind, element: string) =>
        setIcon(as(tx, blind), { kind, id: element }, ICON).catch(
          (error: unknown) => error,
        );
      for (const [kind, element] of [
        ["dataset", id.sales],
        ["workspace", id.sales_workspace],
      ] as const) {
        const missing = await answer(kind, randomUUID());
        expect(missing).toMatchObject({ kind: "not_found" });
        expect(await answer(kind, element)).toEqual(missing);
      }
    }));

  it("answers a curator who cannot see a metric's datasets like a missing metric", () =>
    rolledBack(async (tx) => {
      const metricId = await metricIn(tx, "icon_hidden_metric");
      await fileUnder(tx, metricId, id.profit);
      const error = await setIcon(
        as(tx),
        { kind: "metric", id: metricId },
        ICON,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: "not_found" });
      const [row] = await tx
        .select({ icon: metric.icon })
        .from(metric)
        .where(eq(metric.id, metricId));
      expect(row?.icon).toBeNull();
    }));
});

describe("an icon does not move what marks curation of meaning", () => {
  it("leaves a human_verified metric human_verified when a token sets its icon", () =>
    rolledBack(async (tx) => {
      const metricId = await metricIn(tx, "icon_verified_metric");
      await fileUnder(tx, metricId, id.net_sales);
      await tx
        .update(metric)
        .set({
          trust_state: "human_verified",
          verified_by: "someone@example.test",
          verified_at: new Date(),
        })
        .where(eq(metric.id, metricId));
      const [before] = await tx
        .select()
        .from(metric)
        .where(eq(metric.id, metricId));
      const token: Principal = { ...curator, via: "api" };
      await setIcon(as(tx, token), { kind: "metric", id: metricId }, ICON);
      const [after] = await tx
        .select()
        .from(metric)
        .where(eq(metric.id, metricId));
      expect(after).toMatchObject({
        icon: ICON,
        trust_state: "human_verified",
        verified_by: before?.verified_by,
        verified_at: before?.verified_at,
        touched_at: before?.touched_at,
      });
    }));

  it("records one book_change per write, with who wrote it and from where", () =>
    rolledBack(async (tx) => {
      const ids = await oneOfEach(tx);
      const token: Principal = { ...curator, via: "mcp" };
      for (const kind of ICON_KINDS)
        await setIcon(as(tx, token), { kind, id: ids[kind] }, ICON);
      for (const kind of ICON_KINDS) {
        const rows = await tx
          .select()
          .from(bookChange)
          .where(
            and(
              eq(bookChange.element_id, ids[kind]),
              eq(bookChange.action, "icon"),
            ),
          );
        expect(rows, kind).toHaveLength(1);
        expect(rows[0], kind).toMatchObject({
          element_kind: kind,
          principal_id: curator.id,
          via: "mcp",
          before: { icon: null },
          after: { icon: ICON },
        });
      }
    }));
});
