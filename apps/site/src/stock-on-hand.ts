// The sample tenant's units on hand per product at the Retail dataset's
// latest stock snapshot, 1 February 2026, lowest first: stockRows() and
// retailProductRows() in packages/powerbi-mock. The hero's reorder list
// draws the five lowest.
export const STOCK_ON_HAND = [
  ["SMP-1006", 10],
  ["SMP-1005", 14],
  ["SMP-1004", 18],
  ["SMP-1003", 22],
  ["SMP-1002", 26],
] as const;
