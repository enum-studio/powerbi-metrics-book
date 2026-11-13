/** The most hits the diagram's search lists under its box. */
export const HITS_SHOWN = 8;

const fold = (text: string) => text.trim().toLocaleLowerCase("en");

/** True when a table's name holds the term, in any case. An empty term matches every table. */
export function matchesTerm(name: string, term: string): boolean {
  return fold(name).includes(fold(term));
}

/** How well a folded name holds a folded term: at its start, at a word's start, or anywhere. */
function rank(name: string, term: string): number {
  const at = name.indexOf(term);
  if (at === 0) return 0;
  return /[^\p{L}\p{N}]/u.test(name.charAt(at - 1)) ? 1 : 2;
}

/**
 * The tables whose names hold the term, best first and then by name, at most
 * HITS_SHOWN of them. An empty term finds nothing.
 */
export function findTables(names: readonly string[], term: string): string[] {
  const wanted = fold(term);
  if (wanted === "") return [];
  return names
    .filter((name) => fold(name).includes(wanted))
    .map((name) => ({ name, rank: rank(fold(name), wanted) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.name.localeCompare(b.name, "en", {
          numeric: true,
          sensitivity: "base",
        }),
    )
    .slice(0, HITS_SHOWN)
    .map((hit) => hit.name);
}
