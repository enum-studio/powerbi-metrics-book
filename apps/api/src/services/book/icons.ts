import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { category, metric, term } from "../../db/schema/book.js";
import { powerbiDataset, powerbiWorkspace } from "../../db/schema/mirror.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import { withEvents } from "../events/feed.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { recordBookChange, requireCurator } from "./changes.js";
import { KINDS } from "./docs.js";
import { ICON_COLORS, ICON_GLYPHS } from "./icon-glyphs.js";

/*
 * An icon on a metric, category, term, workspace or dataset: `emoji:<one
 * emoji>` or `glyph:<name>:<color>`. It is a curator's choice of look, not of
 * meaning, so it records a book_change and touches nothing that marks the
 * curation of meaning (trust state, touched_at). The database holds the same
 * shape in a CHECK; this is the sentence that says what to change.
 */

export const ICON_KINDS = [
  "metric",
  "category",
  "term",
  "workspace",
  "dataset",
] as const;
export type IconKind = (typeof ICON_KINDS)[number];

/** The longest emoji the column's CHECK takes, in characters (code points). */
const EMOJI_CHARACTERS = 8;
const EMOJI_BYTES = 32;

const TABLES = {
  metric,
  category,
  term,
  workspace: powerbiWorkspace,
  dataset: powerbiDataset,
} as const;

/** One emoji as Unicode lists it, without an ASCII character: a flag, a family and a skin tone count; a keycap or a tagged sequence does not. */
const EMOJI = /^(?!.*\p{ASCII})\p{RGI_Emoji}$/v;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function invalid(sentence: string): never {
  throw new ServiceError("invalid", sentence);
}

/** The icon as it is stored: an emoji written with a superfluous U+FE0F (as emoji lists do) loses it. */
function checkIcon(icon: string): string {
  if (icon.startsWith("emoji:")) {
    let emoji = icon.slice("emoji:".length);
    if (!EMOJI.test(emoji) && EMOJI.test(emoji.replaceAll("\uFE0F", ""))) {
      emoji = emoji.replaceAll("\uFE0F", "");
    }
    const graphemes = [...segmenter.segment(emoji)];
    if (graphemes.length !== 1 || !EMOJI.test(emoji)) {
      invalid(`${icon} is not one emoji. Give one emoji.`);
    }
    if (
      Array.from(emoji).length > EMOJI_CHARACTERS ||
      Buffer.byteLength(emoji) > EMOJI_BYTES
    ) {
      invalid(`${icon} is too long to be one emoji. Give a shorter emoji.`);
    }
    return `emoji:${emoji}`;
  }
  if (icon.startsWith("glyph:")) {
    const parts = icon.slice("glyph:".length).split(":");
    const [name, color] = parts;
    if (parts.length !== 2 || name === undefined || color === undefined) {
      invalid(`${icon} is not an icon. Write glyph:<name>:<color>.`);
    }
    if (!(ICON_GLYPHS as readonly string[]).includes(name)) {
      invalid(`${icon} is not an icon. Run pbmb icons list for the names.`);
    }
    if (!(ICON_COLORS as readonly string[]).includes(color)) {
      invalid(
        `${color} is not an icon color. Use one of ${ICON_COLORS.join(", ")}.`,
      );
    }
    return icon;
  }
  invalid(`${icon} is not an icon. It must start with emoji: or glyph:.`);
}

/** Where the caller may reach the element: a metric as the lists show it, a dataset or workspace as docs does, and a term or category always. */
async function reach(
  context: ServiceContext,
  kind: IconKind,
): Promise<SQL | undefined> {
  const { db } = context;
  if (kind === "term" || kind === "category") return undefined;
  const allowed = await context.access.describableDatasets(context.principal);
  if (kind === "metric") {
    return and(
      isNull(metric.dismissed_at),
      visibleMetric(db, allowed, !(await readsPii(context))),
    );
  }
  const docsKind = KINDS[kind];
  if (docsKind === undefined) throw new Error(`No docs kind for ${kind}`);
  return and(
    isNull(TABLES[kind].removed_at),
    docsKind.reach(db, allowed, undefined),
  );
}

export async function setIcon(
  context: ServiceContext,
  element: { kind: IconKind; id: string },
  given: string | null,
): Promise<{ kind: IconKind; id: string; icon: string | null }> {
  await requireCurator(context);
  const icon = given === null ? null : checkIcon(given);
  const table = TABLES[element.kind];
  const reaches = await reach(context, element.kind);
  return withEvents(context.db, async (tx) => {
    const [row] = await tx
      .select({ icon: table.icon })
      .from(table)
      .where(and(eq(table.id, element.id), reaches))
      .for("update");
    if (row === undefined) {
      throw new ServiceError(
        "not_found",
        element.kind === "dataset"
          ? NO_SUCH_DATASET
          : `No such ${element.kind}.`,
      );
    }
    if (row.icon === icon) return { ...element, icon };
    await tx.update(table).set({ icon }).where(eq(table.id, element.id));
    await recordBookChange(tx, {
      principal: context.principal,
      element_kind: element.kind,
      element_id: element.id,
      action: "icon",
      before: { icon: row.icon },
      after: { icon },
    });
    return { ...element, icon };
  });
}

export function iconChoices(): Promise<{
  glyphs: typeof ICON_GLYPHS;
  colors: typeof ICON_COLORS;
}> {
  return Promise.resolve({ glyphs: ICON_GLYPHS, colors: ICON_COLORS });
}
