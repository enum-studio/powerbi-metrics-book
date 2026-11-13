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
import { powerbiDataset, powerbiWorkspace } from "../../db/schema/mirror.js";
import { ICON_COLORS, ICON_GLYPHS } from "./icon-glyphs.js";
import { iconChoices, setIcon, type IconKind } from "./icons.js";

useMirror();

const curator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const as = (tx: Db) => asPerson(curator, { db: tx });

const CHART = "emoji:\u{1F4C8}";

async function filedMetric(tx: Db): Promise<string> {
  const metricId = await metricIn(tx, "icon_metric");
  await fileUnder(tx, metricId, id.net_sales);
  return metricId;
}

describe("setIcon", () => {
  it("sets a metric's icon, records one book_change and leaves the trust state alone", () =>
    rolledBack(async (tx) => {
      const metricId = await filedMetric(tx);
      const [before] = await tx
        .select({ trust_state: metric.trust_state })
        .from(metric)
        .where(eq(metric.id, metricId));
      expect(
        await setIcon(as(tx), { kind: "metric", id: metricId }, CHART),
      ).toEqual({ kind: "metric", id: metricId, icon: CHART });
      const [after] = await tx
        .select({ trust_state: metric.trust_state, icon: metric.icon })
        .from(metric)
        .where(eq(metric.id, metricId));
      expect(after).toEqual({ trust_state: before?.trust_state, icon: CHART });
      const changes = await tx
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_id, metricId));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        element_kind: "metric",
        action: "icon",
        before: { icon: null },
        after: { icon: CHART },
      });
    }));

  it("sets and clears an icon on each of the five kinds", () =>
    rolledBack(async (tx) => {
      const [cat] = await tx
        .insert(category)
        .values({ name: "Sales", key: "sales" })
        .returning({ id: category.id });
      const [word] = await tx
        .insert(term)
        .values({ name: "Active customer" })
        .returning({ id: term.id });
      const elements: { kind: IconKind; id: string }[] = [
        { kind: "metric", id: await filedMetric(tx) },
        { kind: "category", id: cat?.id ?? "" },
        { kind: "term", id: word?.id ?? "" },
        { kind: "workspace", id: id.sales_workspace },
        { kind: "dataset", id: id.sales },
      ];
      for (const element of elements) {
        expect(
          await setIcon(as(tx), element, "glyph:chart-line:green"),
        ).toMatchObject({ icon: "glyph:chart-line:green" });
        expect(await setIcon(as(tx), element, null)).toMatchObject({
          icon: null,
        });
      }
      const [dataset] = await tx
        .select({ icon: powerbiDataset.icon })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, id.sales));
      const [workspace] = await tx
        .select({ icon: powerbiWorkspace.icon })
        .from(powerbiWorkspace)
        .where(eq(powerbiWorkspace.id, id.sales_workspace));
      expect([dataset?.icon, workspace?.icon]).toEqual([null, null]);
    }));

  it("writes nothing when the icon is already what is asked", () =>
    rolledBack(async (tx) => {
      const element = { kind: "dataset", id: id.sales } as const;
      await setIcon(as(tx), element, CHART);
      await setIcon(as(tx), element, CHART);
      const changes = await tx
        .select()
        .from(bookChange)
        .where(
          and(
            eq(bookChange.action, "icon"),
            eq(bookChange.element_id, id.sales),
          ),
        );
      expect(changes).toHaveLength(1);
    }));

  it.each([
    [
      "glyph:chart:green",
      "glyph:chart:green is not an icon. Run pbmb icons list for the names.",
    ],
    [
      "glyph:chart-line:pink",
      "pink is not an icon color. Use one of gray, green, teal, blue, violet, red, amber, ink.",
    ],
    ["emoji:ab", "emoji:ab is not one emoji. Give one emoji."],
    ["emoji:\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}x", "is not one emoji"],
    ["emoji:", "is not one emoji"],
    ["chart-line", "must start with emoji: or glyph:"],
  ])("refuses %s with a sentence that says what to change", (icon, words) =>
    rolledBack(async (tx) => {
      await expect(
        setIcon(as(tx), { kind: "dataset", id: id.sales }, icon),
      ).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining(words) as unknown,
      });
    }),
  );

  it("takes a flag and a family, one emoji made of several code points", () =>
    rolledBack(async (tx) => {
      const element = { kind: "dataset", id: id.sales } as const;
      for (const emoji of [
        "\u{1F1E9}\u{1F1F0}",
        "\u{1F468}‍\u{1F469}‍\u{1F467}",
      ]) {
        expect(await setIcon(as(tx), element, `emoji:${emoji}`)).toMatchObject({
          icon: `emoji:${emoji}`,
        });
      }
    }));

  it("drops a superfluous variation selector, and keeps a needed one", () =>
    rolledBack(async (tx) => {
      const element = { kind: "dataset", id: id.sales } as const;
      expect(
        await setIcon(as(tx), element, "emoji:\u{1F4B0}\uFE0F"),
      ).toMatchObject({ icon: "emoji:\u{1F4B0}" });
      const [stored] = await tx
        .select({ icon: powerbiDataset.icon })
        .from(powerbiDataset)
        .where(eq(powerbiDataset.id, id.sales));
      expect(stored?.icon).toBe("emoji:\u{1F4B0}");
      const [change] = await tx
        .select({ after: bookChange.after })
        .from(bookChange)
        .where(eq(bookChange.element_id, id.sales));
      expect(change?.after).toEqual({ icon: "emoji:\u{1F4B0}" });
      expect(
        await setIcon(as(tx), element, "emoji:\u2764\uFE0F"),
      ).toMatchObject({ icon: "emoji:\u2764\uFE0F" });
    }));

  it.each([
    ["a keycap", "1\uFE0F\u20E3"],
    ["an emoji followed by a tag character", "\u{1F600}\u{E0041}"],
    [
      "a joined chain that is no emoji",
      `\u{1F468}${"\u200D\u{1F469}".repeat(4)}`,
    ],
  ])("refuses %s as not one emoji", (_, emoji) =>
    rolledBack(async (tx) => {
      await expect(
        setIcon(as(tx), { kind: "dataset", id: id.sales }, `emoji:${emoji}`),
      ).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("is not one emoji") as unknown,
      });
    }),
  );

  it("refuses an emoji longer than the database holds", () =>
    rolledBack(async (tx) => {
      // A kiss with two skin tones: one emoji of ten code points and 35 bytes.
      const kiss = "emoji:\u{1F469}\u{1F3FB}‍❤️‍\u{1F48B}‍\u{1F468}\u{1F3FC}";
      await expect(
        setIcon(as(tx), { kind: "dataset", id: id.sales }, kiss),
      ).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("too long") as unknown,
      });
    }));

  it("answers an element that is not there as not_found", () =>
    rolledBack(async (tx) => {
      for (const kind of [
        "metric",
        "category",
        "term",
        "workspace",
        "dataset",
      ] as const) {
        await expect(
          setIcon(as(tx), { kind, id: randomUUID() }, CHART),
        ).rejects.toMatchObject({ kind: "not_found" });
      }
    }));

  it("refuses a viewer", () =>
    rolledBack(async (tx) => {
      await expect(
        setIcon(
          asPerson(appReader, { db: tx }),
          { kind: "dataset", id: id.sales },
          CHART,
        ),
      ).rejects.toMatchObject({ kind: "refused" });
    }));
});

describe("iconChoices", () => {
  it("gives the glyph names and the colors", async () => {
    expect(await iconChoices()).toEqual({
      glyphs: ICON_GLYPHS,
      colors: ICON_COLORS,
    });
  });
});
