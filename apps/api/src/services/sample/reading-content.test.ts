import { EXPECTED_DRAFTS } from "@powerbi-metrics-book/powerbi-mock";
import { expect, it } from "vitest";
import { CATEGORIES, TERMS } from "./book.js";
import { readingContent, READING_TERMS } from "./reading-content.js";

it("documents every sample draft, using real categories, terms and distinct related metrics", () => {
  const categories = new Set(CATEGORIES.map((category) => category.path));
  const terms = new Set([...TERMS, ...READING_TERMS].map((term) => term.name));
  const bases = EXPECTED_DRAFTS.flatMap((draft) => draft.base);
  for (const { dataset, measure } of bases) {
    const content = readingContent([dataset, measure]);
    expect(categories.has(content.category), `${dataset}/${measure}`).toBe(
      true,
    );
    for (const term of content.primary_dimensions)
      expect(terms.has(term), term).toBe(true);
    const peers = content.related.map((peer) => {
      expect(
        bases.some(
          (base) =>
            base.dataset === peer.measure[0] &&
            base.measure === peer.measure[1],
        ),
        peer.measure.join("/"),
      ).toBe(true);
      return readingContent(peer.measure);
    });
    expect(new Set(peers).size, `${dataset}/${measure}`).toBeGreaterThanOrEqual(
      2,
    );
    expect(peers).not.toContain(content);
  }
});

it("does not invent generic guidance for a new sample measure", () => {
  expect(() => readingContent(["Sales", "Undocumented"])).toThrow(
    "Write reading-page documentation",
  );
});

it("keeps known broken and textual calculations out of business headlines", () => {
  for (const ref of [
    ["Retail", "Weeks of cover"],
    ["Retail", "Report title"],
    ["Sales", "Order lines held"],
  ] as const) {
    expect(readingContent(ref)).toMatchObject({
      building_block: true,
      tier: "diagnostic",
      importance: "low",
    });
  }
});
