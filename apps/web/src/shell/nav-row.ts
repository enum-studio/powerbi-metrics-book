/** How the page's own row reads, unlike a row that is only hovered: the selected row's wash, and the accent. */
const CURRENT_TEXT =
  "data-[status=active]:text-accent data-[status=active]:[&_svg]:text-accent";

/** A row of the left lanes: 28px, washed when hovered, and marked while it is the page. */
export const NAV_ROW = `flex min-h-7 min-w-0 items-center gap-2 rounded px-2 text-ui font-medium text-ink hover:bg-raised pointer-coarse:min-h-(--tap) data-[status=active]:bg-accent-soft ${CURRENT_TEXT} [&_svg]:shrink-0 [&_svg]:text-ink-2`;

/** A row that folds, one washed row with two targets: its arrow folds it and its name goes to the page. */
export const FOLD_ROW =
  "flex min-w-0 items-center gap-1 rounded pl-2 hover:bg-raised";
export const FOLD_ROW_CURRENT = "has-[[data-status=active]]:bg-accent-soft";
const FOLD_NAME =
  "flex min-h-7 min-w-0 flex-1 items-center gap-2 pr-2 text-ui font-medium text-ink pointer-coarse:min-h-(--tap) [&_svg]:shrink-0 [&_svg]:text-ink-2";
export const FOLD_LINK = `${FOLD_NAME} ${CURRENT_TEXT}`;

/** A row standing for the page while the page's own row is not showing, or holding it in a second lane. */
export const STANDS_FOR_PAGE = {
  "data-status": "active",
  "aria-current": "true",
} as const;

/** Brings the row for this page into view, in the tree or among the settings pages. In a closed drawer nothing can scroll, so the drawer calls this again as it opens. */
export function showCurrentRow(within: ParentNode | null) {
  within
    ?.querySelector(
      'nav[aria-label="Catalog"] [data-status="active"], nav[aria-label="Settings pages"] [data-status="active"]',
    )
    ?.scrollIntoView({ block: "nearest" });
}

/** How far a row sits in, 12px a level; a row with no arrow also passes the arrow's place, which is wider on a touch screen. */
export const indent = (depth: number, arrow = true) => ({
  paddingLeft: `calc(8px + ${String(depth * 12)}px${arrow ? "" : " + var(--arrow-place)"})`,
});

/** Sets the arrow's place that indent reads, on the lane that holds the rows. */
export const ARROW_PLACE =
  "[--arrow-place:1.5rem] pointer-coarse:[--arrow-place:calc(var(--tap)+0.25rem)]";

/** Whether a path is one of Settings' pages, which the second lane lists: a person's own under /settings, and the admin's under /admin but Status. */
export const inSettingsPage = (path: string) =>
  path.startsWith("/settings/") || path.startsWith("/admin/");

/** The left lanes' section label. */
export const NAV_LABEL = "px-2 pb-1 text-meta font-semibold text-ink-3";
