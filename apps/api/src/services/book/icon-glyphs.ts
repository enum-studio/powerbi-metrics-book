/*
 * The icons a book element may carry besides an emoji: Lucide icon names for
 * a business catalog, and the eight colors the app draws them in. The
 * database holds the same two lists in a CHECK on every icon column
 * (iconCheck), so a new glyph or color is a migration.
 */

export const ICON_COLORS = [
  "gray",
  "green",
  "teal",
  "blue",
  "violet",
  "red",
  "amber",
  "ink",
] as const;

export const ICON_GLYPHS = [
  // charts
  "chart-line",
  "chart-bar",
  "chart-column",
  "chart-pie",
  "chart-area",
  "chart-scatter",
  "chart-no-axes-column",
  "trending-up",
  "trending-down",
  "activity",
  "gauge",
  "target",
  "percent",
  "sigma",
  // money
  "circle-dollar-sign",
  "dollar-sign",
  "euro",
  "banknote",
  "coins",
  "wallet",
  "credit-card",
  "receipt",
  "piggy-bank",
  "landmark",
  "calculator",
  "badge-percent",
  "scale",
  "hand-coins",
  // people
  "user",
  "users",
  "user-round",
  "user-plus",
  "user-check",
  "contact",
  "handshake",
  "heart",
  "smile",
  "star",
  "award",
  "building",
  "building-2",
  "briefcase",
  // shop
  "shopping-cart",
  "shopping-bag",
  "store",
  "package",
  "package-check",
  "box",
  "boxes",
  "truck",
  "tag",
  "tags",
  "ticket",
  "gift",
  "shirt",
  "warehouse",
  "barcode",
  "undo-2",
  // time
  "calendar",
  "calendar-days",
  "calendar-check",
  "clock",
  "timer",
  "hourglass",
  "history",
  "alarm-clock",
  "repeat",
  // places
  "map-pin",
  "map",
  "globe",
  "earth",
  "compass",
  "flag",
  "plane",
  "ship",
  "house",
  "factory",
  // data
  "database",
  "table",
  "table-2",
  "columns-3",
  "rows-3",
  "layers",
  "layout-dashboard",
  "filter",
  "search",
  "funnel",
  "network",
  "workflow",
  "git-branch",
  "code",
  "server",
  "cloud",
  "key",
  "lock",
  "shield-check",
  // documents
  "file",
  "file-text",
  "file-spreadsheet",
  "file-chart-column",
  "folder",
  "folder-open",
  "book",
  "book-open",
  "bookmark",
  "clipboard-list",
  "notebook",
  "mail",
  "message-square",
  "bell",
  "info",
  "circle-help",
  "lightbulb",
  // shapes
  "square",
  "circle",
  "triangle",
  "diamond",
  "hexagon",
  "pentagon",
  "octagon",
  "zap",
  "sparkles",
  "flame",
  "leaf",
  "sun",
  "moon",
  "layout-grid",
  "hash",
] as const;

/** The SQL of a column's two icon CHECKs: its shape, and a glyph's name against ICON_GLYPHS. A null passes both. */
export function iconCheck(column: string): string {
  const colors = ICON_COLORS.join("|");
  const names = ICON_GLYPHS.map((name) => `'${name}'`).join(", ");
  // An emoji is 1 to 8 characters, none ASCII, none a bidi or zero-width control; U+200D, the joiner of a family emoji, stays.
  const emoji =
    "[^\\u0001-\\u007f\\u200b\\u200c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]{1,8}";
  return (
    `${column} ~ '^(emoji:${emoji}|glyph:[a-z0-9-]{1,40}:(${colors}))$'` +
    ` and octet_length(${column}) <= 38` +
    ` and (${column} not like 'glyph:%' or split_part(${column}, ':', 2) in (${names}))`
  );
}
